using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Globalization;
using System.Collections;
using Anvil.Reading;
using OutSystems.Model;
using ServiceStudio.Model;

namespace Anvil.Core;

/// <summary>Independent comparison of authored model content after native merge.
/// Derived records are addressed through their owners; omissions remain explicit in the receipt.
/// <para><b>Identity rule</b> (one rule for every node; <see cref="IdentityRule"/>). The Studio's native merge (MatchTree,
/// CompareAndMerge) and its importers may give an element whose content they did not change a new local ObjectKey, and a keyed
/// collection enumerates its items in the order of their key hashes. So no identity uses a local key, and no position is
/// read from a collection whose order is not content. An element is, in this order:</para>
/// <list type="number">
/// <item>an element of a producer reference: the producer's element, its GlobalKey (producer module key * producer object
/// key); the reference record itself: its producer module (ReferenceKey);</item>
/// <item>the module: its module key (the module's own identity, which no merge regenerates); an object outside the module
/// (a platform constant): its own key;</item>
/// <item>a derived record the native rebuilds from its owner's content (auto-generated index, add-source operation, implicit
/// data-set parameter, data table, list type, anonymous record structure): its owner and its content;</item>
/// <item>a named element: its owner's identity + kind + Name; when siblings of that kind share the name, the slot that holds
/// it (when theirs differ) and the discriminator below are added;</item>
/// <item>an unnamed element that supplies a value for a target (Parameter, Attribute, Placeholder, Event, Role) or names
/// one (an extended property's Property): its owner's identity + kind + that target's own identity (or that name);</item>
/// <item>any other unnamed element: its owner's identity + kind + the slot of the owner that holds it (the property, or
/// the collection, that the Model API exposes it through), and, when the slot holds more than one element of that kind,
/// its position among them in an ordered slot (an ordered collection, whose order is compared as content) or, in an
/// unordered one, the hash of its own content (its values and the content of its children, references by the kind and
/// name of their targets); twins of one content (two folders of one name in two trees) add what references each one (the
/// readable path of each referer and its property).</item>
/// </list>
/// <para>A local key is never the identity of a node. A reference value is compared through its target's identity, so a
/// reference retargeted to another element still differs. Every property value, ordered children list, set, binding target,
/// expression text and reference, and payload is compared under these identities: a lost element, a changed value, a
/// rename, a reordered ordered list or a retargeted reference refuses and names the element.</para>
/// <para>One rename is not the merge's loss: the one the Studio makes on its own as a rule of NativeNames predicts it from the
/// candidate (<see cref="NativeNamesRule"/>); the proof then compares the candidate renamed that way, and any other difference
/// still refuses.</para></summary>
public static class MergeContentProof
{
    /// <summary>The identity rule this proof applies, named in its receipt.</summary>
    public const string IdentityRule = "ssam-merge-identity/2: producer GlobalKey/ReferenceKey; module key; derived records by owner and content; owner+kind+Name; owner+kind+target identity; owner+kind+slot+position (ordered) or content hash, then referers, (unordered); never a local ObjectKey";

    private static readonly HashSet<string> OrderedCollections = new(StringComparer.Ordinal) {
        "Widgets", "Rows", "Cells", "Assignments", "InputParameters", "OutputParameters", "Attributes", "Sorts", "Conditions", "IndexAttributes"
    };
    private static readonly HashSet<string> SetCollections = new(StringComparer.Ordinal) { "Roles" };
    /// <summary>The reference that tells which value an unnamed element supplies (an argument its parameter, a record value
    /// its attribute, a placeholder content its placeholder, an event handler its event, a role exception its role).</summary>
    private static readonly string[] DefiningReferences = ["Parameter", "Attribute", "Placeholder", "Event", "Role"];

    /// <summary>The rule of the proof for editor state, named in its receipt.</summary>
    public const string EditorStateRule = "ssam-editor-state/1: where a flow node sits on its canvas (HorizontalPosition, VerticalPosition) and how the editor shows an element (ExpandedInWebEditor, DesignMode) are editor state, not content: the Studio's merge keeps, drops or rearranges them on its own, so a difference in them is a note of the proof, never a difference";

    /// <summary>The rule of the proof given the delivery's base, named in its receipt.</summary>
    public const string IntentRule = "ssam-merge-intent/1: with the delivery's base, the proof requires what the delivery wrote (each value the candidate holds differently from the base, each element it created or removed) to be in the merged module as the candidate holds it; a value the delivery did not write that differs in the merged module (an edit made in the Studio while the delivery ran, or the Studio's own) is kept as it is and said as a note, never a difference";

    /// <summary>The editor-state properties (EditorStateRule): the canvas, never the content.</summary>
    internal static readonly HashSet<string> EditorState = new(StringComparer.Ordinal) { "HorizontalPosition", "VerticalPosition", "ExpandedInWebEditor", "DesignMode" };
    private static bool IsEditorState(string property) => property.StartsWith("api:", StringComparison.Ordinal) && EditorState.Contains(property[4..]);
    /// <summary>The elements a note section lists by name; the counts are always whole.</summary>
    private const int NoteElements = 20;

    /// <summary><paramref name="basePath"/>: the delivery's base, the model the merge took as its base. Given, only what the
    /// delivery wrote is required (<see cref="IntentRule"/>); null, every value of the candidate is.</summary>
    public static JsonObject Check(ModelHost host, string expectedPath, string actualPath, string? basePath = null)
        => Check(host, expectedPath, actualPath, basePath != null && File.Exists(basePath) ? File.ReadAllBytes(basePath) : null, basePath);

    /// <summary>F1 review A3/A8: with <paramref name="minePath"/>, the open module captured right before the merge (the person's
    /// edits), the proof also says which of the person's edits the merged module does not have: overridden by the delivery
    /// (on what the job wrote) or lost by the merge (elsewhere), each a note with its elements.</summary>
    public static JsonObject Check(ModelHost host, string expectedPath, string actualPath, string? basePath, string? minePath)
    {
        var proof = Check(host, expectedPath, actualPath, basePath);
        if (basePath == null || minePath == null || !File.Exists(minePath) || !File.Exists(basePath)) return proof;
        ESpace? expected = null, actual = null, basis = null, mine = null;
        try
        {
            expected = host.Load(File.ReadAllBytes(expectedPath)); actual = host.Load(File.ReadAllBytes(actualPath));
            basis = host.Load(File.ReadAllBytes(basePath)); mine = host.Load(File.ReadAllBytes(minePath));
            var labels = new Dictionary<string, string>(StringComparer.Ordinal);
            var expectedValues = Read(expected); var actualValues = Read(actual, null, labels); var baseValues = Read(basis); var mineValues = Read(mine, null, labels);
            PersonsEdits(proof, expectedValues, actualValues, baseValues, mineValues, labels);
        }
        catch (Exception error) when (error is not OutOfMemoryException) { proof["personsEditsError"] = error.Message; }
        finally { ModelHost.Release(expected); ModelHost.Release(actual); ModelHost.Release(basis); ModelHost.Release(mine); }
        return proof;
    }

    /// <summary>The person's edits (mine against base) the merged module does not hold as the person left them.</summary>
    internal static void PersonsEdits(JsonObject proof, Dictionary<(string Key, string Property), string> expected, Dictionary<(string Key, string Property), string> actual,
        Dictionary<(string Key, string Property), string> basis, Dictionary<(string Key, string Property), string> mine, IReadOnlyDictionary<string, string> labels)
    {
        static bool Same(bool a, string? x, bool b, string? y) => a == b && (!a || Normalize(x!) == Normalize(y!));
        var written = new HashSet<string>(expected.Keys.Union(basis.Keys)
            .Where(f => !Same(expected.TryGetValue(f, out var v), v, basis.TryGetValue(f, out var w), w)).Select(f => f.Key), StringComparer.Ordinal);
        bool Under(string key) => written.Any(w => w == key || w.StartsWith(key + "/", StringComparison.Ordinal));
        var overridden = new SortedSet<string>(StringComparer.Ordinal); var lost = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var field in mine.Keys.Union(basis.Keys))
        {
            if (IsEditorState(field.Property)) continue;
            var minePresent = mine.TryGetValue(field, out var edited);
            if (Same(minePresent, edited, basis.TryGetValue(field, out var before), before)) continue;
            if (Same(actual.TryGetValue(field, out var now), now, minePresent, edited)) continue;
            var name = labels.GetValueOrDefault(field.Key) ?? field.Key;
            if (Under(field.Key) || !Same(expected.TryGetValue(field, out var wanted), wanted, basis.TryGetValue(field, out var b2), b2)) overridden.Add(name);
            else lost.Add(name);
        }
        var notes = proof["notes"] as JsonArray ?? new JsonArray();
        static string List(SortedSet<string> names) => string.Join(", ", names.Take(5)) + (names.Count > 5 ? ", ..." : "");
        if (overridden.Count > 0)
        {
            proof["personsEditsOverridden"] = new JsonArray(overridden.Take(NoteElements).Select(n => (JsonNode)n).ToArray());
            notes.Add(overridden.Count + " element(s) the person edited or removed in the Studio while the delivery ran are now as the delivery wrote them (" + List(overridden)
                + "): the delivery's version wins where both changed the same element");
        }
        if (lost.Count > 0)
        {
            proof["personsEditsLost"] = new JsonArray(lost.Take(NoteElements).Select(n => (JsonNode)n).ToArray());
            notes.Add(lost.Count + " element(s) the person edited in the Studio while the delivery ran are not as the person left them after the merge, outside what the delivery wrote ("
                + List(lost) + "): said so they can be delivered again if they are needed");
        }
        if (notes.Count > 0) proof["notes"] = notes;
    }

    /// <summary>The same proof with the base given as bytes (the disposable previews hold it in memory).</summary>
    internal static JsonObject Check(ModelHost host, string expectedPath, string actualPath, byte[]? baseBytes, string? basePath = null)
    {
        ESpace? expected = null, actual = null, basis = null;
        try
        {
            var expectedBytes = File.ReadAllBytes(expectedPath); var actualBytes = File.ReadAllBytes(actualPath);
            expected = host.Load(expectedBytes);
            actual = host.Load(actualBytes);
            var omittedExpected = new JsonArray(); var omittedActual = new JsonArray();
            var expectedLabels = new Dictionary<string, string>(StringComparer.Ordinal); var actualLabels = new Dictionary<string, string>(StringComparer.Ordinal);
            var identitiesOfExpected = new Dictionary<IObjectSignature, string>(ReferenceEqualityComparer.Instance);
            var expectedValues = Read(expected, omittedExpected, expectedLabels, identitiesOfExpected); var actualValues = Read(actual, omittedActual, actualLabels);
            Dictionary<(string Key, string Property), string>? baseValues = null;
            if (baseBytes != null) { basis = host.Load(baseBytes); baseValues = Read(basis); ModelHost.Release(basis); basis = null; }
            var proof = Compare(expectedValues, actualValues, expectedLabels, actualLabels, baseValues);
            // R3-C (K2): a name the Studio gave on its own in the merge is accepted only as NativeNames predicted it from the
            // candidate (NativeRenamed); anything else keeps this refusal.
            if (proof["accepted"]?.GetValue<bool>() != true
                && NativeRenamed(expected, expectedValues, actualValues, identitiesOfExpected, expectedLabels, actualLabels, proof, baseValues) is { } renamed)
                proof = renamed;
            proof["inputs"] = new JsonObject {
                ["expected"] = new JsonObject { ["path"] = Path.GetFullPath(expectedPath), ["sha256"] = Convert.ToHexString(SHA256.HashData(expectedBytes)).ToLowerInvariant() },
                ["actual"] = new JsonObject { ["path"] = Path.GetFullPath(actualPath), ["sha256"] = Convert.ToHexString(SHA256.HashData(actualBytes)).ToLowerInvariant() },
                ["base"] = baseBytes == null ? null : new JsonObject { ["sha256"] = Convert.ToHexString(SHA256.HashData(baseBytes)).ToLowerInvariant() },
                ["nativeModelVersion"] = typeof(ESpace).Assembly.GetName().Version?.ToString()
            };
            proof["coverage"] = new JsonObject {
                ["complete"] = false,
                ["identity"] = IdentityRule,
                ["boundary"] = "Public Model API content, excluding producer implementation and platform metadata. No element is identified by its local key: producer elements by their GlobalKey, named elements by owner, kind and name, unnamed ones by owner, kind and the target they supply or the slot that holds them (position in an ordered slot, content in an unordered one); derived lists, records, source operations and implicit parameters use their content. Unsupported values and getter failures are listed below. This is not a compiler or runtime proof.",
                ["expectedOmissions"] = omittedExpected, ["actualOmissions"] = omittedActual,
                ["byKind"] = new JsonArray(expectedValues.Where(v => v.Key.Property == "$kind").GroupBy(v => v.Value)
                    .OrderBy(g => g.Key, StringComparer.Ordinal).Select(g => (JsonNode)new JsonObject { ["kind"] = g.Key, ["objects"] = g.Count() }).ToArray())
            };
            return proof;
        }
        finally { ModelHost.Release(expected); ModelHost.Release(actual); ModelHost.Release(basis); }
    }

    /// <summary><paramref name="identityMap"/>: when given, receives the identity of every element read (NativeRenamed reads the
    /// identity of an element a rule renames).</summary>
    internal static Dictionary<(string Key, string Property), string> Read(ESpace model, JsonArray? omissions = null, Dictionary<string, string>? labels = null,
        Dictionary<IObjectSignature, string>? identityMap = null)
    {
        var values = new Dictionary<(string, string), string>();
        var identities = new Dictionary<IObjectSignature, string>(ReferenceEqualityComparer.Instance);
        var resolving = new HashSet<IObjectSignature>(ReferenceEqualityComparer.Instance);
        var identityOwners = new Dictionary<string, IObjectSignature>(StringComparer.Ordinal);
        var slotsOf = new Dictionary<IObjectSignature, Dictionary<IObjectSignature, Slot>>(ReferenceEqualityComparer.Instance);
        var signatures = new Dictionary<IObjectSignature, string>(ReferenceEqualityComparer.Instance);
        var placedSignatures = new Dictionary<IObjectSignature, string>(ReferenceEqualityComparer.Instance);
        Dictionary<IObjectSignature, List<(IObjectSignature Referer, string Property)>>? referersOf = null;
        var root = (IObjectSignature)model;
        var moduleKey = root.ObjectKey?.ToString() ?? "";
        string Kind(IObjectSignature node) => node.GetInterface()?.Name ?? node.GetType().Name;
        string? NameOf(IObjectSignature node) => SafeProp(node, "Name") as string is { Length: > 0 } name ? name : null;
        // The readable element of an identity, for the refusal: kind:name segments below the module (an argument by its
        // parameter), e.g. ServerAction:ConsumerAction/ExecuteServerActionNode:Save/Argument:Code.
        string Label(IObjectSignature node)
        {
            var segments = new List<string>();
            for (var n = node; n != null && n is not IESpace; n = n.Parent as IObjectSignature) {
                var name = ModelHost.Prop(n, "Name")?.ToString();
                if (string.IsNullOrEmpty(name) && ModelHost.Prop(n, "Parameter") is IObjectSignature parameter) name = ModelHost.Prop(parameter, "Name")?.ToString();
                var kind = Kind(n); if (kind.Length > 1 && kind[0] == 'I' && char.IsUpper(kind[1])) kind = kind[1..];
                segments.Add(string.IsNullOrEmpty(name) ? kind : kind + ":" + name);
            }
            segments.Reverse();
            return string.Join("/", segments);
        }
        // An element of a producer reference (the consumer's copy of a producer element, e.g. a referenced server action and
        // its parameters) is the PRODUCER's element: its GlobalKey, <producer module key>*<producer object key>. The local key
        // of that copy is the platform's: the native merge adds its own copy with new keys, so a call bound
        // to the same producer element is the same content, and a call bound to another producer element still differs.
        string? ProducerIdentity(IObjectSignature node)
        {
            // The reference record itself (IReference) is the consumer's dependency on one producer module: a merge that
            // adds the first reference to that producer creates it with a key of its own. Its producer module key
            // (ReferenceKey) is its identity; its name, hash, kind and the rest are still compared below.
            if (Kind(node) == "IReference")
                return ModelHost.Prop(node, "ReferenceKey")?.ToString() is { Length: > 0 } producerModule ? "producer-module:" + producerModule : null;
            var inReference = false;
            for (var n = node; n != null && !inReference; n = n.Parent as IObjectSignature)
                inReference = n is ServiceStudio.Model.Interfaces.ITopLevelReferenceElement || Kind(n) == "IReference";
            if (!inReference) return null;
            var global = ModelHost.Prop(node, "GlobalKey")?.ToString();
            var star = global?.IndexOf('*') ?? -1;
            // A global key of this module is a local element: the general rule below identifies it.
            if (global == null || star <= 0 || star == global.Length - 1 || string.Equals(global[..star], moduleKey, StringComparison.Ordinal)) return null;
            return "producer:" + global;
        }
        bool InModule(IObjectSignature node)
        {
            for (var n = node; n != null; n = ParentOf(n))
                if (ReferenceEquals(n, root)) return true;
            return false;
        }
        bool Inside(IObjectSignature node, IObjectSignature ancestor)
        {
            for (var n = node; n != null; n = ParentOf(n))
                if (ReferenceEquals(n, ancestor)) return true;
            return false;
        }
        // The slots of an owner: for each child, the property (or the collection) of the owner's Model API that holds it, and
        // its position among the children of its kind in that slot. Direct properties first, then the ordered and set
        // collections, then the others (alphabetical within each), so a child listed twice takes its canonical slot.
        Dictionary<IObjectSignature, Slot> Slots(IObjectSignature parent)
        {
            if (slotsOf.TryGetValue(parent, out var known)) return known;
            var map = new Dictionary<IObjectSignature, Slot>(ReferenceEqualityComparer.Instance);
            var direct = new List<(string Name, IObjectSignature Child)>();
            var lists = new List<(string Name, int Rank, bool Ordered, List<IObjectSignature> Items)>();
            foreach (var property in ModelApiMetadata.Properties(parent.GetType()).Where(p => p.CanRead && p.GetIndexParameters().Length == 0)
                .DistinctBy(p => p.Name).OrderBy(p => p.Name, StringComparer.Ordinal)) {
                if (ModelReader<IObjectSignature>.IsNoise(property.Name)) continue;
                if (!typeof(IObjectSignature).IsAssignableFrom(property.PropertyType)
                    && (!typeof(IEnumerable).IsAssignableFrom(property.PropertyType) || property.PropertyType == typeof(string))) continue;
                object? value;
                try { value = property.GetValue(parent); } catch { continue; }
                if (value is IObjectSignature child) { if (ReferenceEquals(ParentOf(child), parent)) direct.Add((property.Name, child)); }
                else if (value is IEnumerable list && value is not string) {
                    List<IObjectSignature> items;
                    try { items = list.OfType<IObjectSignature>().Where(i => ReferenceEquals(ParentOf(i), parent)).ToList(); } catch { continue; }
                    if (items.Count == 0) continue;
                    var ordered = OrderedCollections.Contains(property.Name) || Sequenced(value);
                    lists.Add((property.Name, OrderedCollections.Contains(property.Name) || SetCollections.Contains(property.Name) ? 0 : 1, ordered, items));
                }
            }
            foreach (var (name, child) in direct) map.TryAdd(child, new Slot(name, true, 0, 1));
            foreach (var (name, _, ordered, items) in lists.OrderBy(l => l.Rank)) {
                var free = items.Where(i => !map.ContainsKey(i)).ToList();
                foreach (var group in free.GroupBy(Kind)) {
                    var members = group.ToList();
                    for (var i = 0; i < members.Count; i++) map.TryAdd(members[i], new Slot(name, ordered, i, members.Count));
                }
            }
            // A child no property exposes: the owner's children, an unordered slot.
            foreach (var group in parent.Children.OfType<IObjectSignature>().Where(c => !map.ContainsKey(c)).GroupBy(Kind)) {
                var members = group.ToList();
                for (var i = 0; i < members.Count; i++) map.TryAdd(members[i], new Slot("children", false, i, members.Count));
            }
            slotsOf[parent] = map;
            return map;
        }
        // The content of an element without any identity in it: its kind, its values (a reference by the kind and name of
        // its target), and the content of its children, sorted. It tells apart unnamed siblings of an unordered slot.
        // A7 (F1 review): the content of an element without editor state (EditorStateRule), so a node the Studio or the person
        // moved on the canvas keeps its identity; exact twins that only their canvas place tells apart use PlacedSignature.
        string Signature(IObjectSignature node) => SignatureOf(node, false);
        string PlacedSignature(IObjectSignature node) => SignatureOf(node, true);
        string SignatureOf(IObjectSignature node, bool placed)
        {
            var cache = placed ? placedSignatures : signatures;
            if (cache.TryGetValue(node, out var known)) return known;
            var parts = new List<string> { Kind(node) };
            foreach (var property in ModelApiMetadata.Properties(node.GetType())
                .Where(p => p.GetIndexParameters().Length == 0 && p.CanRead && (p.CanWrite || OrderedCollections.Contains(p.Name) || SetCollections.Contains(p.Name)))
                .DistinctBy(p => p.Name).OrderBy(p => p.Name, StringComparer.Ordinal)) {
                if (ModelReader<IObjectSignature>.IsNoise(property.Name) || (!placed && EditorState.Contains(property.Name))) continue;
                object? value;
                try { value = property.GetValue(node); } catch { continue; }
                var shallow = value switch {
                    string or byte[] => ContentValue(value, _ => ""),
                    IExpression expression => "expression:" + expression.Text,
                    IObjectSignature reference => "reference:" + Kind(reference) + ":" + NameOf(reference),
                    IEnumerable list when value is not string => "list:" + string.Join(",", list.OfType<IObjectSignature>().Select(r => Kind(r) + ":" + NameOf(r))),
                    _ => ContentValue(value, _ => "")
                };
                if (shallow != null) parts.Add(property.Name + "=" + shallow);
            }
            if (node is IExpression own) parts.Add("$expression=" + own.Text);
            parts.AddRange(node.Children.OfType<IObjectSignature>().Select(child => SignatureOf(child, placed)).OrderBy(s => s, StringComparer.Ordinal));
            return cache[node] = Hash(string.Join("\n", parts));
        }
        // What points at an element, without any identity in it: the readable path of each referer and the property, sorted.
        // It tells apart twins, siblings of one kind whose own content is the same (two folders of one name in two trees of
        // the module: what each one holds is what references it). Built once, on the first twins.
        Dictionary<IObjectSignature, List<string>>? incoming = null;
        string Incoming(IObjectSignature node)
        {
            if (incoming == null) {
                incoming = new Dictionary<IObjectSignature, List<string>>(ReferenceEqualityComparer.Instance);
                var walk = new Stack<IObjectSignature>(); walk.Push(root);
                var seen = new HashSet<IObjectSignature>(ReferenceEqualityComparer.Instance);
                void Add(IObjectSignature target, IObjectSignature referer, string property) {
                    if (ReferenceEquals(ParentOf(target), referer)) return;
                    if (!incoming.TryGetValue(target, out var list)) incoming[target] = list = new List<string>();
                    list.Add(Label(referer) + "." + property);
                }
                while (walk.TryPop(out var n)) {
                    if (!seen.Add(n) || n is ServiceStudio.Model.Interfaces.ITopLevelReferenceElement) continue;
                    foreach (var property in ModelApiMetadata.Properties(n.GetType())
                        .Where(p => p.GetIndexParameters().Length == 0 && p.CanRead && (p.CanWrite || SetCollections.Contains(p.Name)))
                        .DistinctBy(p => p.Name)) {
                        if (ModelReader<IObjectSignature>.IsNoise(property.Name)) continue;
                        object? value;
                        try { value = property.GetValue(n); } catch { continue; }
                        if (value is IObjectSignature target) Add(target, n, property.Name);
                        else if (value is IEnumerable list && value is not string)
                            try { foreach (var item in list.OfType<IObjectSignature>()) Add(item, n, property.Name); } catch { }
                    }
                    IEnumerable<IObjectSignature> children;
                    try { children = n.Children.OfType<IObjectSignature>().ToList(); } catch { continue; }
                    foreach (var child in children) walk.Push(child);
                }
            }
            return incoming.TryGetValue(node, out var referers) ? string.Join("\n", referers.OrderBy(r => r, StringComparer.Ordinal)) : "";
        }
        // Siblings of one kind (and one name) in one slot: the position in an ordered slot (order is content there), else
        // the hash of the element's content, and for twins of one content also what references each one.
        string Discriminator(IObjectSignature node, Slot slot, List<IObjectSignature> siblings)
        {
            if (siblings.Count <= 1) return "";
            if (slot.Ordered) return "#" + siblings.FindIndex(s => ReferenceEquals(s, node)).ToString(CultureInfo.InvariantCulture);
            var signature = Signature(node);
            if (siblings.Count(s => Signature(s) == signature) == 1) return "~" + signature[..16];
            var referred = Hash(signature + "\n" + Incoming(node));
            if (siblings.Count(s => Signature(s) == signature && Hash(signature + "\n" + Incoming(s)) == referred) == 1) return "~" + referred[..16];
            // Twins whose referers read alike (two Ends, each the target of one of two twin Assigns): the referers' own
            // referers tell them apart (the If's true and false branches), never the canvas.
            var twoSteps = Hash(signature + "\n" + ReferersTwoSteps(node));
            if (siblings.Count(s => Signature(s) == signature && Hash(signature + "\n" + ReferersTwoSteps(s)) == twoSteps) == 1) return "~" + twoSteps[..16];
            // Exact twins (same content, same referers): only their place on the canvas tells them apart, as before A7.
            return "~" + Hash(PlacedSignature(node) + "\n" + Incoming(node))[..16];
        }
        // What points at an element two steps back, in readable paths only (never an identity, so no order of computation
        // enters): each referer and its property, followed by what points at that referer. Two Ends, each the target of one
        // of two twin Assigns, differ here by the If's true and false branches.
        string ReferersTwoSteps(IObjectSignature node)
        {
            Incoming(node);
            if (referersOf == null)
            {
                referersOf = new Dictionary<IObjectSignature, List<(IObjectSignature Referer, string Property)>>(ReferenceEqualityComparer.Instance);
                var walk = new Stack<IObjectSignature>(); walk.Push(root);
                var seen = new HashSet<IObjectSignature>(ReferenceEqualityComparer.Instance);
                while (walk.TryPop(out var n)) {
                    if (!seen.Add(n) || n is ServiceStudio.Model.Interfaces.ITopLevelReferenceElement) continue;
                    foreach (var property in ModelApiMetadata.Properties(n.GetType())
                        .Where(p => p.GetIndexParameters().Length == 0 && p.CanRead && p.CanWrite).DistinctBy(p => p.Name)) {
                        if (ModelReader<IObjectSignature>.IsNoise(property.Name)) continue;
                        object? value;
                        try { value = property.GetValue(n); } catch { continue; }
                        if (value is IObjectSignature target && !ReferenceEquals(ParentOf(target), n)) {
                            if (!referersOf.TryGetValue(target, out var list)) referersOf[target] = list = new();
                            list.Add((n, property.Name));
                        }
                    }
                    IEnumerable<IObjectSignature> children;
                    try { children = n.Children.OfType<IObjectSignature>().ToList(); } catch { continue; }
                    foreach (var child in children) walk.Push(child);
                }
            }
            if (!referersOf.TryGetValue(node, out var referers)) return "";
            return string.Join("\n", referers.Select(r => Label(r.Referer) + "." + r.Property + "<" + Incoming(r.Referer).Replace("\n", "|")).OrderBy(i => i, StringComparer.Ordinal));
        }
        string Identity(IObjectSignature node)
        {
            if (identities.TryGetValue(node, out var id)) return id;
            if (!resolving.Add(node)) throw new InvalidOperationException("Merge proof: cyclic derived identity in " + Kind(node));
            try { id = IdentityCore(node); identities.Add(node, id); if (labels != null) labels.TryAdd(id, Label(node)); return id; }
            finally { resolving.Remove(node); }
        }
        string IdentityCore(IObjectSignature node)
        {
            string id;
            var kind = Kind(node);
            // 1. A producer's element.
            if (ProducerIdentity(node) is { } producerElement) return producerElement;
            // 2. The module, and what is not in it (a platform constant).
            if (node is IESpace) return "module:" + (node.ObjectKey?.ToString() ?? "");
            if (!InModule(node)) return "external:" + (ModelHost.Prop(node, "GlobalKey")?.ToString() ?? node.ObjectKey?.ToString() ?? kind);
            var parent = ParentOf(node)!;
            // 3. Derived records, rebuilt by the native from their owner's content.
            if (node is EntityIndex { AutoGenerated: true } generatedIndex)
                return GeneratedIndexIdentity(Identity(parent), generatedIndex.IndexAttributes.Select(a => Identity(a.Attribute)));
            // Add-source records are derived for each alias. Two aliases of the same entity may
            // use two equivalent records; the alias itself, including its name, remains measured.
            if (kind == "IAddSourceOperation" && ModelHost.Prop(node, "Source") is IObjectSignature dataSource)
                return "source:" + Identity(parent) + ":" + Identity(dataSource);
            if (kind == "DataSetImplicitParameter") {
                var value = ModelHost.Prop(node, "Value") as IExpression;
                var references = (ModelHost.Prop(value!, "ReferedObjects") as IEnumerable)?.OfType<IObjectSignature>()
                    .Select(Identity).OrderBy(k => k, StringComparer.Ordinal) ?? Enumerable.Empty<string>();
                return Identity(parent) + "/implicit:" + Hash((value?.Text ?? "") + "\n" + string.Join("\n", references));
            }
            if (kind == "DataTable") return Identity(parent);
            if (node is OutSystems.Model.Types.IListType list)
                return "list:" + Identity(list.ElementType);
            if (kind == "IAnonymousStructure") {
                // Aggregate record fields are named. Native merge may reorder its sources and hence
                // this derived record; declared structure/SQL output ordering is not normalized here.
                var attributes = ((IEnumerable)ModelHost.Prop(node, "Attributes")!).OfType<IObjectSignature>()
                    .OrderBy(a => ModelHost.Prop(a, "Name")?.ToString(), StringComparer.Ordinal);
                // A field whose type does not resolve (a broken expression of an invalid model) is "unresolved", never an exception.
                return "record:" + Hash(string.Join("\n", attributes.Select(a => ModelHost.Prop(a, "Name") + ":" + (ModelHost.Prop(a, "DataType") is IObjectSignature type ? Identity(type) : "unresolved"))));
            }
            var owner = Identity(parent);
            var slot = Slots(parent).TryGetValue(node, out var held) ? held : new Slot("children", false, 0, 1);
            // 4. A named element: owner, kind and name; siblings of one kind and one name are told apart as below.
            if (NameOf(node) is { } name) {
                var namesakes = Slots(parent).Where(s => Kind(s.Key) == kind && NameOf(s.Key) == name).ToList();
                var discriminator = "";
                if (namesakes.Count > 1) {
                    // Namesakes in other slots are told apart by the slot; in the same slot, as unnamed siblings are.
                    var sameSlot = namesakes.Where(s => s.Value.Name == slot.Name).OrderBy(s => s.Value.Position).Select(s => s.Key).ToList();
                    discriminator = (sameSlot.Count < namesakes.Count ? "@" + slot.Name : "") + Discriminator(node, slot, sameSlot);
                }
                id = owner + "/" + kind + ":" + name + discriminator;
            }
            // 5. An unnamed element that supplies a value for a target: owner, kind and the target's own identity.
            else if (DefiningTarget(node) is { } target) id = owner + "/" + kind + "[" + target + "]";
            // 6. Any other unnamed element: owner, kind and the slot that holds it.
            else {
                var siblings = Slots(parent).Where(s => s.Value.Name == slot.Name && Kind(s.Key) == kind)
                    .OrderBy(s => s.Value.Position).Select(s => s.Key).ToList();
                id = owner + "/" + kind + "[" + slot.Name + Discriminator(node, slot, siblings) + "]";
            }
            if (identityOwners.TryGetValue(id, out var holder) && !ReferenceEquals(holder, node)) {
                // Two records with one canonical identity: the later one is numbered, and the receipt says so.
                var n = 2;
                while (identityOwners.ContainsKey(id + "#" + n.ToString(CultureInfo.InvariantCulture))) n++;
                omissions?.Add(new JsonObject { ["object"] = id, ["property"] = "$identity", ["reason"] = "ambiguous canonical identity, numbered #" + n.ToString(CultureInfo.InvariantCulture) });
                id += "#" + n.ToString(CultureInfo.InvariantCulture);
            }
            identityOwners[id] = node;
            return id;
        }
        string? DefiningTarget(IObjectSignature node)
        {
            foreach (var property in DefiningReferences)
                if (SafeProp(node, property) is IObjectSignature target && !Inside(target, node) && !resolving.Contains(target))
                    return property + "=" + Identity(target);
            // An extended property names the property it extends.
            if (Kind(node) == "IExtendedProperty" && SafeProp(node, "Property") is string extended && extended.Length > 0) return "Property=" + extended;
            return null;
        }
        var pending = new Stack<IObjectSignature>(); pending.Push(root);
        var visited = new HashSet<IObjectSignature>(ReferenceEqualityComparer.Instance);
        while (pending.TryPop(out var node))
        {
            if (!visited.Add(node)) continue;
            if (node is ServiceStudio.Model.Interfaces.ITopLevelReferenceElement) continue;
            if (Kind(node) == "DataTable") {
                foreach (var child in node.Children.OfType<IObjectSignature>()) pending.Push(child);
                continue;
            }
            if (node is OutSystems.Model.Types.IListType || Kind(node) == "IAnonymousStructure") continue;
            if (Kind(node) == "IAddSourceOperation") continue;
            if (node is EntityIndexAttribute) continue; // represented, in order, by the index below
            // These are generated edge records, whose order and keys change on load. Their semantics are the
            // owner's Target/TrueTarget/FalseTarget/CycleTarget/OtherwiseTarget properties, compared below.
            if (node is OutSystems.Model.Logic.IActionConnector) continue;
            var key = Identity(node);
            values[(key, "$kind")] = node.GetInterface()?.FullName ?? node.GetType().FullName!;
            values[(key, "$parentKind")] = node.Parent is IObjectSignature owner ? Kind(owner) : "";
            values[(key, "$parent")] = node.Parent is IObjectSignature parent ? Identity(parent) : "";
            if (node is RoleException roleException)
                values[(key, "Role")] = roleException.Role is IObjectSignature exceptionRole ? Identity(exceptionRole) : "";
            if (node is EntityIndex index) {
                values[(key, "index:AutoGenerated")] = index.AutoGenerated.ToString();
                values[(key, "index:Name")] = index.Name;
                values[(key, "index:Unique")] = index.Unique.ToString();
                values[(key, "index:Attributes")] = string.Join("\n", index.IndexAttributes.Select(a => a.Attribute == null ? "" : Identity(a.Attribute)));
            }
            foreach (var property in ModelApiMetadata.Properties(node.GetType())
                .Where(p => p.GetIndexParameters().Length == 0 && p.CanRead && (p.CanWrite || OrderedCollections.Contains(p.Name) || SetCollections.Contains(p.Name)))
                .GroupBy(p => p.Name).Select(g => g.First()))
            {
                if (ModelReader<IObjectSignature>.IsNoise(property.Name)) continue;
                // Index attributes are recreated edge records; the ordered referenced attributes
                // are already compared by index:Attributes, including auto-generated indexes.
                if (node is EntityIndex && property.Name == "IndexAttributes") continue;
                object? value;
                try { value = property.Name == "SourceEntity" && Kind(node) == "IComboBoxWidget"
                    ? ModelSession.UIProperty(node, property.Name) : property.GetValue(node); }
                catch (Exception error) {
                    var reason = error.GetBaseException().GetType().Name;
                    omissions?.Add(new JsonObject { ["object"] = key, ["property"] = property.Name, ["reason"] = reason });
                    values[(key, "$unread:" + property.Name)] = reason; continue;
                }
                if (property.Name == "Conditions" && node is OutSystems.Model.Logic.Nodes.ISwitchNode && value is IEnumerable conditions) {
                    // Switch connectors are recreated by native merge. Their keys are not identity,
                    // but priority, expression bindings, destination and the branch label are content.
                    var branches = new JsonArray();
                    foreach (var branch in conditions.OfType<IObjectSignature>()) {
                        var branchExpression = ModelHost.Prop(branch, "Value") as IExpression
                            ?? throw new InvalidOperationException("Switch condition has no readable Value expression");
                        var target = ModelHost.Prop(branch, "Target") as IObjectSignature;
                        var refs = (ModelHost.Prop(branchExpression, "ReferedObjects") as IEnumerable)?.OfType<IObjectSignature>()
                            .Select(Identity).Distinct().OrderBy(k => k, StringComparer.Ordinal) ?? Enumerable.Empty<string>();
                        branches.Add(new JsonObject { ["value"] = branchExpression.Text, ["label"] = ModelHost.Prop(branch, "Label")?.ToString(), ["target"] = target == null ? null : Identity(target),
                            ["references"] = new JsonArray(refs.Select(r => (JsonNode?)JsonValue.Create(r)).ToArray()) });
                    }
                    values[(key, "ordered:Conditions")] = branches.ToJsonString();
                }
                else if (OrderedCollections.Contains(property.Name) && value is IEnumerable collection)
                    values[(key, "ordered:" + property.Name)] = string.Join("\n", collection.OfType<IObjectSignature>().Select(Identity));
                else if (SetCollections.Contains(property.Name) && value is IEnumerable set)
                    values[(key, "set:" + property.Name)] = string.Join("\n", set.OfType<IObjectSignature>().Select(Identity).OrderBy(v => v, StringComparer.Ordinal));
                else if (ContentValue(value, Identity) is { } content) values[(key, "api:" + property.Name)] = content;
                else omissions?.Add(new JsonObject { ["object"] = key, ["property"] = property.Name, ["reason"] = "unsupported value type", ["type"] = value?.GetType().FullName });
            }
            // Expression.Text alone misses a rebind to a homonymous object.
            if (node is IExpression expression)
            {
                values[(key, "$expression")] = expression.Text ?? "";
                if (ModelHost.Prop(node, "ReferedObjects") is IEnumerable references)
                    values[(key, "$references")] = string.Join("\n", references.OfType<IObjectSignature>()
                        .Select(Identity).Distinct().OrderBy(k => k, StringComparer.Ordinal));
            }
            // DefaultScreen is persisted by the Model API but a native Traditional merge can drop it.
            // Include null too: losing a requested clear is just as much a content mismatch as losing a set.
            // These bindings are compared through their target's identity, never the target's local key.
            if (node is IESpace espace)
                values[(key, "DefaultScreen")] = espace.DefaultScreen is IObjectSignature screen ? Identity(screen) : "";
            if (node is OutSystems.Model.Logic.Nodes.IRefreshDataNode refresh)
                values[(key, "DataSource")] = refresh.DataSource is IObjectSignature source ? Identity(source) : "";
            if (node is OutSystems.Model.Logic.Nodes.IAjaxRefreshNode ajax)
                values[(key, "WidgetOrWebBlock")] = ajax.WidgetOrWebBlock is IObjectSignature refreshed ? Identity(refreshed) : "";
            if (node is OutSystems.Model.UI.Web.Events.ILinkOnClick click) {
                values[(key, "Method")] = click.Method.ToString();
                values[(key, "Validation")] = click.Validation.ToString();
                values[(key, "Destination")] = click.Destination is IObjectSignature destination ? Identity(destination) : "";
            }
            if (ThemeCss.Of(node) is { } sheet)
            {
                values[(key, "StyleSheet")] = sheet.EffectiveValue ?? "";
                values[(key, "UserStyleSheet")] = sheet.UserEffectiveValue ?? "";
                values[(key, "GeneratedStyleSheet")] = sheet.GeneratedEffectiveValue ?? "";
            }
            foreach (var child in node.Children.OfType<IObjectSignature>().Concat(EntityIndexes.NativeChildren(node))) pending.Push(child);
        }
        if (identityMap != null) foreach (var (element, identity) in identities) identityMap[element] = identity;
        return values;
    }

    /// <summary>The rule of the proof for the names the Studio gives on its own (NativeNames), named in its receipt.</summary>
    public const string NativeNamesRule = "ssam-native-names/1: a rename is accepted only as NativeNames predicts it from the candidate: the old name gone and the predicted one present under the same owner and of the same kind, and, with the candidate renamed by the Studio's own SetName, no other difference";

    /// <summary>
    /// R3-C (K2): the proof again, when the Studio renamed an element on its own exactly as a rule of NativeNames predicts from
    /// the candidate (an aggregate named Get + plural that received a filter by an attribute became Get + plural + By + the
    /// attribute). A predicted pair counts only when the module shows it: the identity of the old name is gone from the merged
    /// module and the identity with the predicted name (same owner, same kind) is there, and not in the candidate. Those pairs
    /// are applied to the candidate with the Studio's own SetName (which rewrites the expressions that name the element, as
    /// the merge did), and the candidate is read and compared again. The answer is that comparison: accepted only with no
    /// difference at all; refused with the differences left (the renames are named in nativeNames either way). Null when no
    /// predicted pair is in the merged module, or when a rename does not take: the first comparison stands.
    /// </summary>
    private static JsonObject? NativeRenamed(ESpace expected, Dictionary<(string Key, string Property), string> expectedValues,
        Dictionary<(string Key, string Property), string> actualValues, IReadOnlyDictionary<IObjectSignature, string> identities,
        IReadOnlyDictionary<string, string> expectedLabels, IReadOnlyDictionary<string, string> actualLabels, JsonObject plain,
        Dictionary<(string Key, string Property), string>? baseValues = null)
    {
        List<NativeNames.Rename> predicted;
        try { predicted = NativeNames.Predict(expected); }
        catch { return null; }
        var seen = new List<(NativeNames.Rename Rename, string From, string To)>();
        foreach (var rename in predicted)
        {
            // A named element told by its name alone (identity rule 4 without a discriminator): owner/kind:name.
            if (!identities.TryGetValue(rename.Element, out var from) || !from.EndsWith(":" + rename.From, StringComparison.Ordinal)) continue;
            var to = from[..^rename.From.Length] + rename.To;
            if (actualValues.ContainsKey((to, "$kind")) && !actualValues.ContainsKey((from, "$kind")) && !expectedValues.ContainsKey((to, "$kind")))
                seen.Add((rename, from, to));
        }
        if (seen.Count == 0) return null;
        // The Studio's SetName changes the model only inside a command (the merge ran it inside its own): one command for all.
        var applied = true;
        try { StudioAdapter.Runtime.Mutate(expected, "SSAM: native names of the merge", _ => { foreach (var (rename, _, _) in seen) applied &= NativeNames.Apply(rename.Element, rename.To); }); }
        catch { return null; }
        if (!applied) return null;
        var labels = new Dictionary<string, string>(StringComparer.Ordinal);
        var proof = Compare(Read(expected, null, labels), actualValues, labels, actualLabels, baseValues);
        proof["nativeNames"] = new JsonObject
        {
            ["rule"] = NativeNamesRule,
            ["renames"] = new JsonArray(seen.Select(s => (JsonNode)NativeNames.Json(s.Rename, expectedLabels.GetValueOrDefault(s.From) ?? s.From)).ToArray()),
            ["differencesWithoutRenames"] = (plain["differences"] as JsonArray)?.Count ?? 0,
        };
        return proof;
    }

    /// <summary>The identity of an auto-generated index (rule 3): its entity's identity and the identities of its attributes,
    /// in order. A delivery names the index the Studio derives from one attribute by it (Delivery.MatchKnownLosses).</summary>
    internal static string GeneratedIndexIdentity(string entityIdentity, IEnumerable<string> attributeIdentities)
        => entityIdentity + "/generated-index:" + Hash(string.Join("\n", attributeIdentities));

    /// <summary>A child's place in its owner: the slot (property or collection) that holds it, whether that slot's order is
    /// content, its position among the children of its kind there, and how many there are.</summary>
    private readonly record struct Slot(string Name, bool Ordered, int Position, int Count);

    /// <summary>An ordered native collection (a C5 sequence: Studio "SSSequence" lists): its order is content.</summary>
    private static bool Sequenced(object collection)
    {
        for (var type = collection.GetType(); type != null && type != typeof(object); type = type.BaseType)
            if (type.Name.Contains("Sequence", StringComparison.Ordinal)) return true;
        return collection.GetType().GetInterfaces().Any(i => i.Name.StartsWith("ISequenced", StringComparison.Ordinal));
    }

    /// <summary>The owner of a model object; null when the native getter refuses (a platform placeholder type has none).</summary>
    private static IObjectSignature? ParentOf(IObjectSignature node)
    {
        try { return node.Parent as IObjectSignature; } catch { return null; }
    }

    /// <summary>A property by name on the type or any interface (the Model API implements some explicitly), never throwing.</summary>
    private static object? SafeProp(object o, string name)
    {
        try { return ModelHost.Prop(o, name); } catch { return null; }
    }

    private static string? ContentValue(object? value, Func<IObjectSignature, string> identity) => value switch
    {
        null => "null",
        IExpression expression => "expression:" + expression.Text,
        IObjectSignature reference => "reference:" + identity(reference),
        string text => "text:" + text,
        bool boolean => boolean ? "true" : "false",
        Enum enumeration => "enum:" + enumeration.GetType().FullName + ":" + enumeration,
        byte[] bytes => "bytes:" + Convert.ToHexString(SHA256.HashData(bytes)),
        IFormattable scalar when value.GetType().IsPrimitive || value is decimal or DateTime or Guid
            => "scalar:" + scalar.ToString(null, CultureInfo.InvariantCulture),
        _ => null
    };

    internal static JsonObject Compare(Dictionary<(string Key, string Property), string> expected, Dictionary<(string Key, string Property), string> actual,
        IReadOnlyDictionary<string, string>? expectedLabels = null, IReadOnlyDictionary<string, string>? actualLabels = null,
        Dictionary<(string Key, string Property), string>? basis = null)
    {
        var differences = new JsonArray();
        // Editor state (EditorStateRule) and, given the base, what the delivery did not write (IntentRule): notes, never
        // differences. Counted whole; the first NoteElements of each are named.
        var editorState = new JsonArray(); var outside = new JsonArray();
        int editorStateTotal = 0, outsideTotal = 0;
        var sameElement = new SortedSet<string>(StringComparer.Ordinal);
        static bool Same(bool presentA, string? a, bool presentB, string? b) => presentA == presentB && (!presentA || Normalize(a!) == Normalize(b!));
        // A field the delivery wrote: the candidate holds it otherwise than the base (another value, or present on one side only).
        bool Written((string Key, string Property) field, bool expectedPresent, string? value)
            => basis == null || !Same(expectedPresent, value, basis.TryGetValue(field, out var before), before);
        var writtenElements = basis == null ? null : new HashSet<string>(expected.Keys.Union(basis.Keys)
            .Where(f => Written(f, expected.TryGetValue(f, out var v), v)).Select(f => f.Key), StringComparer.Ordinal);
        bool OrderedIntentHolds((string Key, string Property) field, string expectedList, string actualList, out List<string> extra)
        {
            extra = new List<string>();
            if (!field.Property.StartsWith("ordered:", StringComparison.Ordinal) || field.Property == "ordered:Conditions") return false;
            static List<string> Items(string list) => Normalize(list).Split('\n', StringSplitOptions.RemoveEmptyEntries).ToList();
            var wanted = Items(expectedList); var got = Items(actualList);
            var before = basis!.TryGetValue(field, out var baseList) ? Items(baseList) : new List<string>();
            if (wanted.Except(before).Any(item => !got.Contains(item)) || before.Except(wanted).Any(got.Contains)) return false;
            var kept = got.Where(wanted.Contains).ToList();
            if (!kept.SequenceEqual(wanted.Where(got.Contains))) return false;
            extra = got.Where(item => !wanted.Contains(item)).ToList();
            return true;
        }
        // Each difference names its element (the readable path of the candidate's element, else the module's) and, for a
        // reference or an expression, the readable value on each side: a refusal lists what differs, never only hashes.
        string Element(string key) => expectedLabels?.GetValueOrDefault(key) ?? actualLabels?.GetValueOrDefault(key) ?? key;
        string? Readable(string property, string? value, IReadOnlyDictionary<string, string>? labels)
        {
            if (value == null) return null;
            string Name(string id) => labels?.GetValueOrDefault(id) ?? Element(id);
            if (value.StartsWith("reference:", StringComparison.Ordinal)) return "reference:" + Name(value["reference:".Length..]);
            if (property is "$references" or "$parent" || property.StartsWith("ordered:", StringComparison.Ordinal) || property.StartsWith("set:", StringComparison.Ordinal))
                return Clip(string.Join("\n", value.Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(Name)));
            if (property is "$expression" || value.StartsWith("expression:", StringComparison.Ordinal) || value.StartsWith("text:", StringComparison.Ordinal)
                || value.StartsWith("scalar:", StringComparison.Ordinal) || value.StartsWith("enum:", StringComparison.Ordinal) || value is "true" or "false" or "null")
                return Clip(value);
            return null;
        }
        foreach (var field in expected.Keys.Union(actual.Keys).OrderBy(x => x.Key, StringComparer.Ordinal).ThenBy(x => x.Property, StringComparer.Ordinal))
        {
            var expectedPresent = expected.TryGetValue(field, out var value);
            var present = actual.TryGetValue(field, out var got);
            if (expectedPresent && present && Normalize(value!) == Normalize(got!)) continue;
            // The canvas place of an element added or removed as a whole is part of that addition or removal, said there.
            if (IsEditorState(field.Property) && (!present || !expectedPresent)) continue;
            if (IsEditorState(field.Property))
            {
                if (editorStateTotal++ < NoteElements)
                    editorState.Add(new JsonObject { ["element"] = Element(field.Key), ["property"] = field.Property[4..],
                        ["expectedValue"] = expectedPresent ? Readable(field.Property, value, expectedLabels) : null,
                        ["actualValue"] = present ? Readable(field.Property, got, actualLabels) : null });
                continue;
            }
            if (!Written(field, expectedPresent, value))
            {
                // The owner's rule (same element edited by both): counted whole, named in a note of its own.
                if (writtenElements!.Contains(field.Key)) sameElement.Add(Element(field.Key));
                if (outsideTotal++ < NoteElements)
                    outside.Add(new JsonObject { ["element"] = Element(field.Key), ["property"] = field.Property,
                        ["change"] = !present ? "removed" : !expectedPresent ? "added" : "changed",
                        // (c) of the owner's rule: an element this delivery wrote, whose other values were edited outside it.
                        ["onWrittenElement"] = writtenElements!.Contains(field.Key) });
                continue;
            }
            // A1 (F1 review): an ordered child list the job wrote and the person also added to (two attributes of one entity,
            // two widgets of one container): only the job's intention is required. Its added children are present, its
            // removed ones absent, and its children keep their relative order; the person's extra children stay, noted.
            if (basis != null && expectedPresent && present && OrderedIntentHolds(field, value!, got!, out var extra))
            {
                if (writtenElements!.Contains(field.Key)) sameElement.Add(Element(field.Key));
                if (outsideTotal++ < NoteElements)
                    outside.Add(new JsonObject { ["element"] = Element(field.Key), ["property"] = field.Property, ["change"] = "added",
                        ["children"] = new JsonArray(extra.Take(5).Select(e => (JsonNode)Element(e)).ToArray()), ["onWrittenElement"] = true });
                continue;
            }
            differences.Add(new JsonObject { ["objectKey"] = field.Key.Split('/')[0], ["address"] = field.Key, ["property"] = field.Property,
                ["element"] = Element(field.Key),
                ["kind"] = expected.GetValueOrDefault((field.Key, "$kind")) ?? actual.GetValueOrDefault((field.Key, "$kind")),
                ["parentKind"] = expected.GetValueOrDefault((field.Key, "$parentKind")) ?? actual.GetValueOrDefault((field.Key, "$parentKind")),
                ["missing"] = !present, ["unexpected"] = !expectedPresent,
                ["expectedSha256"] = expectedPresent ? Hash(value!) : null, ["actualSha256"] = present ? Hash(got!) : null,
                ["expected"] = IsBinding(field.Property) ? value : null,
                ["actual"] = IsBinding(field.Property) && present ? got : null,
                ["expectedValue"] = expectedPresent ? Readable(field.Property, value, expectedLabels) : null,
                ["actualValue"] = present ? Readable(field.Property, got, actualLabels) : null,
                // B17 (proto c995402e): a stylesheet that differs says how, byte by byte (CssStylesheet.Compare); the
                // acceptance itself is unchanged (modulo line endings, Normalize).
                ["css"] = IsStyleSheet(field.Property) && expectedPresent && present ? CssSummary(CssStylesheet.Compare(value, got)) : null });
        }
        var proof = new JsonObject { ["schema"] = "ssam-merge-content-proof/1", ["accepted"] = differences.Count == 0,
            ["scope"] = "Object identity/parent, public writable scalar/reference/expression properties, expression text/references, ESpace.DefaultScreen, refresh targets, Traditional links and all stylesheet values outside producer references; unsupported property value types are not covered",
            ["checked"] = expected.Count, ["differences"] = differences, ["css"] = CssSection(expected, actual, Element) };
        if (basis != null) proof["intent"] = new JsonObject { ["rule"] = IntentRule, ["written"] = writtenElements!.Count };
        var notes = new JsonArray();
        if (editorStateTotal > 0)
        {
            proof["editorState"] = new JsonObject { ["rule"] = EditorStateRule, ["total"] = editorStateTotal, ["elements"] = editorState };
            notes.Add(editorStateTotal + " editor-state value(s) (canvas positions, expanded or design state) differ from the candidate (" + Names(editorState)
                + "): moved by the Studio's merge or by the person; editor state is no content, so the module keeps them as they are");
        }
        if (outsideTotal > 0)
        {
            proof["outsideDelivery"] = new JsonObject { ["rule"] = IntentRule, ["total"] = outsideTotal, ["elements"] = outside };
            // A3/A9 (F1 review): each kind of change said apart, with the elements; a removal is never called kept.
            foreach (var (change, verb) in new[] { ("changed", "changed"), ("added", "added"), ("removed", "removed") })
            {
                var these = outside.OfType<JsonObject>().Where(o => o["change"]?.ToString() == change).ToList();
                if (these.Count == 0) continue;
                // An element added or removed as a whole is one entry, by its element; a changed value is one per property.
                var whole = change != "changed";
                var listed = whole ? these.Where(o => o["property"]?.ToString() == "$kind" || o["children"] != null).Select(o => { var e = (JsonObject)o.DeepClone(); e.Remove("property"); return (JsonNode)e; }).ToArray()
                    : these.Select(o => (JsonNode)o.DeepClone()).ToArray();
                if (listed.Length == 0) listed = these.Select(o => { var e = (JsonObject)o.DeepClone(); e.Remove("property"); return (JsonNode)e; }).ToArray();
                var count = whole ? listed.Select(e => e!["element"]?.ToString()).Distinct().Count() : listed.Length;
                notes.Add(count + (outsideTotal > NoteElements ? "+" : "") + (whole ? " element(s)" : " value(s)") + " this delivery did not write were " + verb
                    + " in the Studio while it ran (" + Names(new JsonArray(listed))
                    + "): the module has them as the person left them; what the delivery wrote is in the module");
            }
        }
        if (sameElement.Count > 0)
        {
            proof["sameElement"] = new JsonObject { ["total"] = sameElement.Count, ["elements"] = new JsonArray(sameElement.Take(NoteElements).Select(e => (JsonNode)e).ToArray()) };
            notes.Add(sameElement.Count + " element(s) this delivery wrote were also edited in the Studio while it ran (" + string.Join(", ", sameElement.Take(5)) + (sameElement.Count > 5 ? ", ..." : "") + "): the values the delivery wrote are in the module, and the person's other values of the same element(s) stay");
        }
        if (notes.Count > 0) proof["notes"] = notes;
        return proof;

        static string Names(JsonArray entries)
        {
            var names = entries.OfType<JsonObject>().Select(e => e["element"]?.ToString() + (e["property"]?.ToString() is { Length: > 0 } p && !p.StartsWith('$') ? " " + p.Replace("api:", "") : "")
                + (e["children"] is JsonArray { Count: > 0 } children ? " +" + string.Join(" +", children.Select(c => c?.ToString())) : "")).Distinct().ToList();
            return string.Join(", ", names.Take(5)) + (names.Count > 5 ? ", ..." : "");
        }
    }
    private static bool IsBinding(string property) => property is "DataSource" or "DefaultScreen" or "WidgetOrWebBlock" or "Method" or "Validation" or "Destination"
        or "$references" or "$parent" or "ordered:Widgets";
    private static string Normalize(string text) => text.Replace("\r\n", "\n");

    // B17 (proto c995402e, lote 4 F2): every stylesheet of the candidate (screen, block, theme: StyleSheet and the theme's two
    // halves) byte by byte. The acceptance stays modulo line endings (Normalize): CRLF against LF is how the Studio may store
    // the same CSS, and the section says so (lineEndingsOnly) instead of hiding it.
    private static bool IsStyleSheet(string property) => property is "StyleSheet" or "UserStyleSheet" or "GeneratedStyleSheet";

    private static JsonObject CssSummary(JsonObject compare)
    {
        var summary = new JsonObject { ["bytesEqual"] = compare["bytesEqual"]?.DeepClone(), ["lineEndingsOnly"] = compare["lineEndingsOnly"]?.DeepClone(),
            ["firstDifference"] = compare["firstDifference"] is JsonObject at ? new JsonObject { ["line"] = at["line"]!.DeepClone(), ["column"] = at["column"]!.DeepClone() } : null };
        if (compare["rules"] is JsonObject rules)
            summary["rules"] = new JsonObject { ["expected"] = rules["expected"]!.DeepClone(), ["actual"] = rules["actual"]!.DeepClone(),
                ["lost"] = rules["lost"]!.DeepClone(), ["added"] = rules["added"]!.DeepClone(), ["reordered"] = rules["reordered"]!.DeepClone(),
                ["lostRules"] = rules["lostRules"]!.DeepClone(), ["addedRules"] = rules["addedRules"]!.DeepClone() };
        return summary;
    }

    /// <summary>B17: the stylesheets of the candidate compared with the merged module byte by byte: how many, how many are the
    /// same bytes, how many differ only in line endings, how many differ otherwise (differingTotal) and the first
    /// <see cref="CssDiffering"/> of those with their rules lost, added or reordered; a stylesheet the merged module does not
    /// have at all is missing.</summary>
    internal static JsonObject CssSection(Dictionary<(string Key, string Property), string> expected, Dictionary<(string Key, string Property), string> actual,
        Func<string, string> element)
    {
        int sheets = 0, same = 0, lineEndings = 0, other = 0;
        var differing = new JsonArray();
        foreach (var (field, value) in expected.Where(f => IsStyleSheet(f.Key.Property)).OrderBy(f => f.Key.Key, StringComparer.Ordinal).ThenBy(f => f.Key.Property, StringComparer.Ordinal))
        {
            sheets++;
            JsonObject entry;
            if (!actual.TryGetValue(field, out var got)) entry = new JsonObject { ["missing"] = true };
            else
            {
                var compare = CssStylesheet.Compare(value, got);
                if (compare["bytesEqual"]!.GetValue<bool>()) { same++; continue; }
                if (compare["lineEndingsOnly"]?.GetValue<bool>() == true) { lineEndings++; continue; }
                entry = CssSummary(compare);
            }
            other++;
            entry["element"] = element(field.Key); entry["property"] = field.Property;
            if (differing.Count < CssDiffering) differing.Add(entry);
        }
        return new JsonObject { ["sheets"] = sheets, ["bytesEqual"] = same, ["lineEndingsOnly"] = lineEndings, ["differingTotal"] = other, ["differing"] = differing };
    }
    private const int CssDiffering = 20;
    private static string Clip(string text) => text.Length <= 300 ? text : text[..300] + "...";
    private static string Hash(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Normalize(text)))).ToLowerInvariant();
}
