using System.Collections;
using System.Diagnostics;
using System.Globalization;
using System.Text;

namespace Anvil.Reading;

// One loaded module read as ssam-html/1 (ScreenHtml): built once per capture (the walk and the names), then each screen or
// block is read in its own document. A reference is written as the shortest of Name, Owner.Name, Kind:Name, Kind:Owner.Name
// that the decoder resolves back to exactly the element the model points at, else @id.
public sealed partial class ScreenHtmlModule<T> where T : class
{
    private readonly ModelReader<T> r;
    private readonly T module;
    private readonly List<T> nodes = [];
    private readonly Dictionary<T, int> at = new(ReferenceEqualityComparer.Instance);
    private readonly int[] parent, root;
    private readonly int[][] childrenOf;
    private readonly string[] key, kind, display, role, id;
    private readonly Dictionary<string, List<int>> byName = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, int> byId = new(StringComparer.Ordinal);
    // Targets outside the walk (basic and derived types, system elements): id "~Kind:Name".
    private readonly Dictionary<string, (string Kind, string Name)> outside = new(StringComparer.Ordinal);
    private readonly Dictionary<string, List<string>> outsideByName = new(StringComparer.OrdinalIgnoreCase);
    private readonly object gate = new();
    public string ModuleName { get; }
    public double LoadMs { get; }
    // The defaults of the reading: the installed Studio's for the UI flow a page is in (ScreenDefaults, from the reader's adapter:
    // what a fresh element is born with depends on the module and on the theme of its flow), asked once per flow, when a page of
    // it is read or a writer starts (a module without screens is never asked by a reading); null: a new UI flow. The same
    // module read again after a change keeps them.
    private readonly Dictionary<T, ScreenDefaults> defaultsByFlow;
    private ScreenDefaults? newFlowDefaults;
    internal ScreenDefaults DefaultsIn(T? flow)
    {
        lock (gate) {
            if (flow == null) return newFlowDefaults ??= r.DefaultsOf(module, null) ?? ScreenDefaults.None;
            if (!defaultsByFlow.TryGetValue(flow, out var known)) defaultsByFlow[flow] = known = r.DefaultsOf(module, flow) ?? ScreenDefaults.None;
            return known;
        }
    }
    // The defaults of a screen or block: those of the UI flow it is in.
    internal ScreenDefaults DefaultsOfRoot(int rootIndex) =>
        DefaultsIn(rootIndex >= 0 && parent[rootIndex] is var p and >= 0 && role[p] == "flow" ? nodes[p] : null);

    internal ScreenHtmlModule(T module, ModelReader<T> reader) : this(module, reader, null, -1) { }

    // previous + dirty: the same module after a change confined to one screen or block (C2, ScreenHtmlEdit): every node outside
    // that root keeps what the previous reading asked the model (kind, role, children, key, name); the root's subtree is walked
    // again. The text of the root read from it is the text a fresh reading gives.
    private ScreenHtmlModule(T module, ModelReader<T> reader, ScreenHtmlModule<T>? previous, int dirty)
    {
        var sw = Stopwatch.StartNew();
        this.module = module; r = reader;
        defaultsByFlow = previous != null ? new(previous.defaultsByFlow, ReferenceEqualityComparer.Instance) : new(ReferenceEqualityComparer.Instance);
        newFlowDefaults = previous?.newFlowDefaults;
        ModuleName = r.DisplayOf(module);
        // One walk in the order of ModelReader.Walk (depth first, children in model order, a node once), reading the
        // children of each node once: the reads of every screen use them (childrenOf) instead of asking the model again.
        // The body of an action is not walked: the page names its actions and nothing more (the logic text reads them),
        // and most nodes of a module are flow nodes. A reference into a body is an element outside the walk (IdOf).
        var parentOf = new Dictionary<T, T>(ReferenceEqualityComparer.Instance);
        var listed = new List<T[]>(); var kinds = new List<string>(); var roleList = new List<string>();
        var reused = new List<int>();
        var roles = new Dictionary<IReadOnlySet<string>, string>(ReferenceEqualityComparer.Instance);
        var pending = new Stack<T>(); pending.Push(module);
        while (pending.TryPop(out var node)) {
            if (at.ContainsKey(node)) continue;
            at[node] = nodes.Count; nodes.Add(node);
            T[] children;
            if (previous != null && previous.at.TryGetValue(node, out var pi) && previous.root[pi] != dirty && pi != dirty) {
                kinds.Add(previous.kind[pi]); roleList.Add(previous.role[pi]); reused.Add(pi);
                children = Array.ConvertAll(previous.childrenOf[pi], c => previous.nodes[c]);
            } else {
                var k = r.KindOf(node); var names = r.KindNamesOf(node);
                if (!roles.TryGetValue(names, out var rl)) roles[names] = rl = ModuleIndex.Roles[ModuleIndex.RoleOf(k, new HashSet<string>(names, StringComparer.Ordinal))];
                kinds.Add(k); roleList.Add(rl); reused.Add(-1);
                children = rl == "action" ? [] : r.ChildrenOf(node).ToArray();
            }
            listed.Add(children);
            foreach (var child in children) parentOf.TryAdd(child, node);
            for (var c = children.Length - 1; c >= 0; c--) pending.Push(children[c]);
        }
        var walkMs = sw.Elapsed.TotalMilliseconds;
        var n = nodes.Count;
        parent = new int[n]; root = new int[n]; childrenOf = new int[n][];
        key = new string[n]; kind = new string[n]; display = new string[n]; role = new string[n]; id = new string[n];
        var seen = new Dictionary<string, int>(StringComparer.Ordinal);
        for (var i = 0; i < n; i++) {
            var node = nodes[i];
            if (reused[i] >= 0) { key[i] = previous!.key[reused[i]]; display[i] = previous.display[reused[i]]; }
            else { key[i] = r.KeyOf(node); display[i] = r.DisplayOf(node); }
            kind[i] = kinds[i]; role[i] = roleList[i];
            parent[i] = parentOf.TryGetValue(node, out var p) ? at[p] : -1;
            childrenOf[i] = Array.ConvertAll(listed[i], c => at[c]);
            var baseId = key[i].Length > 0 ? key[i] : "#" + i.ToString(CultureInfo.InvariantCulture);
            var count = seen[baseId] = seen.GetValueOrDefault(baseId) + 1;
            id[i] = count == 1 ? baseId : baseId + "#" + count.ToString(CultureInfo.InvariantCulture);
            byId[id[i]] = i;
            if (display[i].Length > 0) { if (!byName.TryGetValue(display[i], out var list)) byName[display[i]] = list = []; list.Add(i); }
        }
        // Walk order puts parents first. The root of a node is its own (a screen or block) or its parent's; a signature under
        // a Reference is never a root.
        for (var i = 0; i < n; i++) {
            var p = parent[i];
            root[i] = role[i] is "screen" or "block" && role[i] != "reference" ? i : p >= 0 && role[i] != "reference" ? root[p] : -1;
        }
        same = SameTypes(n);
        LoadMs = sw.Elapsed.TotalMilliseconds;
        LoadDetail = "nodes " + n + " walk " + Math.Round(walkMs) + " ms, names " + Math.Round(LoadMs - walkMs) + " ms";
    }
    public string LoadDetail { get; } = "";

    // One type, one name. A list type is the list of its element: ODC Studio 1.7.29 (model 13.1451) adds to a module it loads the
    // list types of its new system records (Agent*) beside the ones the module keeps, so a module that had a Text List has two
    // list types named Text List, both the list of Text. Two list types of one name and one element are one type: a reference
    // to either is the fact of one of them (the smallest key, whatever the order of the load) and the name answers with it.
    // List types of one name whose elements differ stay two types (the name is ambiguous). Every other node is itself.
    private readonly int[] same;
    private int[] SameTypes(int n)
    {
        var one = new int[n];
        var lists = new Dictionary<object, Dictionary<string, List<int>>>(ReferenceEqualityComparer.Instance);
        for (var i = 0; i < n; i++) {
            one[i] = i;
            if (display[i].Length == 0 || !r.IsKind(nodes[i], "ListType") || ElementOf(nodes[i]) is not { } element) continue;
            if (!lists.TryGetValue(element, out var named)) lists[element] = named = new(StringComparer.Ordinal);
            if (!named.TryGetValue(display[i], out var members)) named[display[i]] = members = [];
            members.Add(i);
        }
        foreach (var members in lists.Values.SelectMany(named => named.Values).Where(m => m.Count > 1)) {
            var first = members.MinBy(i => key[i], StringComparer.Ordinal);
            foreach (var i in members) one[i] = first;
        }
        return one;
    }

    private object? ElementOf(T node)
    {
        try { return r.PropertyOf(node, "ElementType")?.Invoke(); }
        catch (Exception error) when (error is not OutOfMemoryException) { return null; }
    }

    // By kind, name and key: the Model API gives a flow's screens and blocks in another order on each load.
    private IEnumerable<int> RootIndexes() => Enumerable.Range(0, nodes.Count).Where(i => role[i] is "screen" or "block" && root[i] == i)
        .OrderBy(i => kind[i], StringComparer.Ordinal).ThenBy(i => display[i], StringComparer.Ordinal).ThenBy(i => key[i], StringComparer.Ordinal);

    // Screens and blocks of the module (Reactive, Mobile and Traditional), by kind, name and key.
    public IReadOnlyList<(string Name, string Kind, string Key)> Roots => RootIndexes().Select(i => (display[i], kind[i], key[i])).ToList();

    // A root by name (case-insensitive), Kind:Name or @key; ambiguous or missing throws with the candidates.
    public ScreenHtmlDocument Read(string target)
    {
        var roots = RootIndexes().ToList();
        List<int> hits;
        if (target.StartsWith('@')) hits = roots.Where(i => key[i] == target[1..] || id[i] == target[1..]).ToList();
        else {
            var colon = target.IndexOf(':');
            var (k, name) = colon > 0 ? (target[..colon], target[(colon + 1)..]) : ((string?)null, target);
            hits = roots.Where(i => string.Equals(display[i], name, StringComparison.OrdinalIgnoreCase) && (k == null || kind[i] == k)).ToList();
        }
        if (hits.Count != 1)
            throw new InvalidOperationException((hits.Count == 0 ? "No screen or block named '" : "Ambiguous screen or block '") + target + "'. "
                + string.Join("; ", (hits.Count > 0 ? hits : roots).Take(12).Select(i => kind[i] + ":" + display[i] + " @" + key[i])));
        return ReadRoot(hits[0]);
    }

    // Every screen and block; a root the reading cannot write answers its error as a problem of its own document (the
    // others are still read: one root never takes the module down).
    public IEnumerable<ScreenHtmlDocument> ReadAll()
    {
        foreach (var i in RootIndexes().ToList()) {
            ScreenHtmlDocument document;
            try { document = ReadRoot(i); }
            catch (Exception error) {
                var problem = "read failed @" + id[i] + ": " + error.GetBaseException().Message;
                var failed = new ScreenHtmlCanon(); failed.Problems.Add(problem);
                document = new ScreenHtmlDocument { Root = display[i], RootKey = key[i], RootKind = kind[i], HtmlSha256 = ScreenHtml.Sha256(""),
                    Problems = [problem], Canon = failed, Decoder = _ => failed };
            }
            yield return document;
        }
    }

    private ScreenHtmlDocument ReadRoot(int index)
    {
        lock (gate) {
            var sw = Stopwatch.StartNew();
            var writer = new Writer(this, index);
            writer.Run();
            var html = writer.Html.ToString();
            var shapes = writer.Shapes; var scope = writer.Scope;
            return new ScreenHtmlDocument {
                Root = display[index], RootKey = key[index], RootKind = kind[index], Html = html, HtmlSha256 = ScreenHtml.Sha256(html),
                Keys = writer.Keys, Widgets = writer.WidgetCount, OpaqueWidgets = writer.OpaqueCount, Elements = writer.ElementCount,
                ReadMs = sw.Elapsed.TotalMilliseconds, Problems = writer.Canon.Problems.ToList(), Canon = writer.Canon,
                Decoder = parsed => { lock (gate) return new Decoder(this, scope, shapes).Run(parsed); },
                State = new ReadingState(this, index, scope, shapes), DefaultsNote = DefaultsOfRoot(index).Note,
            };
        }
    }

    // What a document keeps of its reading for an edit (C2): the module, the root, the scope of its names and the shapes.
    internal sealed record ReadingState(ScreenHtmlModule<T> Module, int Root, Scope Scope, Dictionary<string, Shape> Shapes);

    // ---- facts ------------------------------------------------------------------------------------------------------------
    internal readonly record struct Fact(string Name, char Type, string Text);
    // What the reading knows of a node to decode it back: its kind, the type of every property it has (also the ones at their
    // default) and the native events it can hold.
    internal sealed class Shape
    {
        public string Kind = ""; public int Node = -1;
        public Dictionary<string, char> Types = new(StringComparer.Ordinal);
        // The type a property that is null would take (from its declared type): what an edit writes on it decodes as that.
        public Dictionary<string, char> NullTypes = new(StringComparer.Ordinal);
        public Dictionary<string, string> NativeEvents = new(StringComparer.Ordinal); // attribute -> event name
        public Dictionary<string, Dictionary<string, char>> EventTypes = new(StringComparer.Ordinal);
        public string? SlotName, SlotPlaceholder;   // a slot: the name it is written with and the placeholder it holds
    }

    // Every property of a node that is a fact of the page, with its type: e expression, t text, v value, b boolean,
    // r reference (the target's id), l list of references (ids, sorted). References to its own children (events, the If
    // branches, an ODC Content) come back as pointers: the structure carries them. Defaults are filtered by the caller.
    private List<Fact> Facts(int i, Shape shape, List<string> problems, out Dictionary<string, T> pointers) =>
        FactsOf(nodes[i], role[i], id[i], new HashSet<T>(childrenOf[i].Select(c => nodes[c]), ReferenceEqualityComparer.Instance),
            parent[i] >= 0 ? nodes[parent[i]] : null, element => Under(element, i), shape, problems, out pointers);

    // The facts of any node, also one the walk does not know (an element C2 just created): its children, its parent and what
    // counts as under it are given.
    private List<Fact> FactsOf(T node, string nodeRole, string where, HashSet<T> children, T? parentNode, Func<T, bool> under, Shape shape,
        List<string> problems, out Dictionary<string, T> pointers)
    {
        var facts = new List<Fact>();
        pointers = new Dictionary<string, T>(StringComparer.Ordinal);
        foreach (var (name, read) in r.PropertiesOf(node)) {
            if (ModelReader<T>.IsNoise(name) || ScreenHtml.NotFacts.Contains(name)) continue;
            if (name == "Type" && nodeRole is "parameter" or "variable" or "aggregate") continue;
            object? value;
            try { value = read(); } catch (Exception error) { problems.Add("read error @" + where + " " + name + ": " + error.GetBaseException().Message); continue; }
            char type; string text;
            switch (value) {
                case null:
                    shape.Types.TryAdd(name, '?');
                    if (r.NullFactTypeOf(node, name) is { } declared) shape.NullTypes.TryAdd(name, declared);
                    continue;
                case byte[]: continue;
                case var _ when r.ExpressionText(value) is { } expression: type = 'e'; text = expression; break;
                case T target:
                    if (ReferenceEquals(target, node) || ReferenceEquals(target, module) || parentNode != null && ReferenceEquals(target, parentNode)) continue;
                    if (children.Contains(target)) { pointers[name] = target; continue; }
                    type = 'r'; text = IdOf(target); break;
                case string s: type = 't'; text = s; break;
                case bool b: type = 'b'; text = b ? "True" : "False"; break;
                case IEnumerable items: {
                    var ids = new List<string>(); var texts = new List<string>(); var structural = true; var any = false;
                    foreach (var item in items) {
                        any = true;
                        if (item is T element) { structural &= children.Contains(element) || under(element); ids.Add(IdOf(element)); }
                        else { structural = false; texts.Add(item is IFormattable f ? f.ToString(null, CultureInfo.InvariantCulture) : item?.ToString() ?? ""); }
                    }
                    if (!any || structural) { shape.Types.TryAdd(name, 'l'); continue; }
                    if (texts.Count > 0) { type = 'v'; text = "[" + string.Join(", ", ids.Concat(texts)) + "]"; }
                    else { type = 'l'; ids.Sort(StringComparer.Ordinal); text = string.Join("\n", ids); }
                    break;
                }
                case IFormattable formattable: type = 'v'; text = formattable.ToString(null, CultureInfo.InvariantCulture); break;
                default: continue;
            }
            shape.Types[name] = type;
            facts.Add(new Fact(name, type, text));
        }
        return facts;
    }

    // A list whose items all sit in the node's own subtree (an aggregate's Filters, Sorts and Sources) repeats the structure.
    private bool Under(T element, int ancestor)
    {
        if (!at.TryGetValue(element, out var i)) return false;
        for (var p = parent[i]; p >= 0; p = parent[p]) if (p == ancestor) return true;
        return false;
    }

    private string IdOf(T target)
    {
        if (at.TryGetValue(target, out var i)) return id[same[i]];
        var k = r.KindOf(target); var name = r.DisplayOf(target);
        // Inside the body of an action of the module (not walked): its own key keeps it apart from a namesake in another
        // body. Anything else outside the walk (basic types, system elements) is its kind and name.
        var outsideId = "~" + k + ":" + name + (InsideBody(target) && r.KeyOf(target) is { Length: > 0 } own ? "@" + own : "");
        if (!outside.ContainsKey(outsideId)) {
            outside[outsideId] = (k, name);
            if (!outsideByName.TryGetValue(name, out var list)) outsideByName[name] = list = [];
            list.Add(outsideId);
        }
        return outsideId;
    }

    private bool InsideBody(T target)
    {
        var seen = new HashSet<T>(ReferenceEqualityComparer.Instance);
        for (var up = r.ParentOf(target); up != null && seen.Add(up); up = r.ParentOf(up))
            if (at.TryGetValue(up, out var i)) return role[i] == "action";
        return false;
    }

    // ---- names ------------------------------------------------------------------------------------------------------------
    // The candidates of a name, nearest first: this screen (not the screen itself), the top-level elements of the module
    // (its children, a flow's screens, a reference's signatures), the rest of the module outside screens, the other
    // screens, then the elements outside the walk this document refers to (action bodies included: the walk stops at an
    // action). The first non-empty tier answers.
    private bool TopLevel(int i) => parent[i] >= 0 && (parent[parent[i]] < 0 || role[parent[i]] == "flow" || kind[parent[i]] == "Reference");
    private int Tier(int i, int scopeRoot) => root[i] == scopeRoot && i != scopeRoot ? 0 : root[i] < 0 && TopLevel(i) ? 1 : root[i] < 0 ? 2 : 3;
    private List<string> Candidates(string name, string? ofKind, string? owner, Scope scope, bool destinations = false, bool blocks = false)
    {
        var tiers = new List<string>[5] { [], [], [], [], [] };
        if (byName.TryGetValue(name, out var list))
            foreach (var i in list) {
                if (ofKind != null && kind[i] != ofKind) continue;
                if (owner != null && (parent[i] < 0 || !string.Equals(display[parent[i]], owner, StringComparison.OrdinalIgnoreCase))) continue;
                if (destinations && !IsDestinationKind(kind[i], role[i])) continue;
                if (blocks && !IsBlockKind(kind[i])) continue;
                var tier = Tier(i, scope.Root);
                // two list types of one type answer once (SameTypes)
                if (!tiers[tier].Contains(id[same[i]])) tiers[tier].Add(id[same[i]]);
            }
        if (owner == null && outsideByName.TryGetValue(name, out var others))
            foreach (var o in others)
                if (scope.Outside.Contains(o) && (ofKind == null || outside[o].Kind == ofKind) && (!destinations || IsDestinationKind(outside[o].Kind, null)) && (!blocks || IsBlockKind(outside[o].Kind))) tiers[4].Add(o);
        return tiers.FirstOrDefault(t => t.Count > 0) ?? [];
    }

    private static bool IsBlockKind(string kindName) => kindName is "WebBlock" or "MobileBlock" or "WebBlockSignature" or "MobileBlockSignature";
    private string KindOfId(string target) => byId.TryGetValue(target, out var i) ? kind[i] : outside.TryGetValue(target, out var o) ? o.Kind : "";

    // The source block of a new <Block name="…">: the name as any reference when that names a block; else among the blocks
    // only. A folder of the producer named like its block (OutSystemsUIWeb: the folder Modal beside References, the block
    // Modal under its flow) was the one hit at the nearest tier, and the platform refused "IFolderSignature, not
    // IWebBlockSignature" (793ca579, live on 20/10).
    internal bool TryResolveBlock(string form, Scope scope, out string target)
    {
        if (TryResolve(form, scope, out target) && IsBlockKind(KindOfId(target))) return true;
        target = "";
        if (form.Length == 0 || form[0] == '@') return false;
        string? ofKind = null; var rest = form;
        var colon = form.IndexOf(':');
        if (colon > 0) { ofKind = form[..colon]; rest = form[(colon + 1)..]; }
        string? owner = null; var dot = rest.LastIndexOf('.');
        if (dot > 0) { owner = rest[..dot]; rest = rest[(dot + 1)..]; }
        var hits = Candidates(rest, ofKind, owner, scope, blocks: true);
        if (hits.Count != 1) return false;
        target = hits[0]; return true;
    }

    // What an event can name: an action or a screen (in the walk by role, outside it by kind).
    private static bool IsDestinationKind(string kindName, string? nodeRole) =>
        nodeRole is "action" or "screen" || kindName.Contains("Action", StringComparison.Ordinal) || kindName.Contains("Screen", StringComparison.Ordinal);

    // The destination of an event (C2): the name as any reference first; when that is ambiguous or names nothing, among the
    // actions and screens only (onclick="Save" names the screen action Save even when a widget or a variable of the screen is
    // also called Save). Never changes what a reading wrote: its references resolve on the first try.
    internal bool TryResolveDestination(string form, Scope scope, out string target)
    {
        if (TryResolve(form, scope, out target)) return true;
        if (form.Length == 0 || form[0] == '@') return false;
        string? ofKind = null; var rest = form;
        var colon = form.IndexOf(':');
        if (colon > 0) { ofKind = form[..colon]; rest = form[(colon + 1)..]; }
        string? owner = null; var dot = rest.LastIndexOf('.');
        if (dot > 0) { owner = rest[..dot]; rest = rest[(dot + 1)..]; }
        var hits = Candidates(rest, ofKind, owner, scope, destinations: true);
        if (hits.Count != 1) { target = ""; return false; }
        target = hits[0]; return true;
    }

    // The scope of the names of one document: its root, and the elements outside the walk that the document refers to (so
    // the text of a screen never depends on what else was read before it).
    internal sealed class Scope(int root)
    {
        public readonly int Root = root;
        public readonly HashSet<string> Outside = new(StringComparer.Ordinal);
    }

    // Every in-tree element a name answers to, with its tier from a screen (a diagnostic of the name rules).
    public IReadOnlyList<string> Explain(string name, string screen)
    {
        var scopeRoot = RootIndexes().FirstOrDefault(i => string.Equals(display[i], screen, StringComparison.OrdinalIgnoreCase), -1);
        var lines = new List<string>();
        if (byName.TryGetValue(name, out var list))
            foreach (var i in list) {
                var tier = Tier(i, scopeRoot);
                lines.Add(tier + " " + kind[i] + ":" + display[i] + " @" + id[i] + " parent " + (parent[i] >= 0 ? kind[parent[i]] + ":" + display[parent[i]] : "-") + " root " + (root[i] >= 0 ? display[root[i]] : "-"));
            }
        return lines;
    }

    internal bool TryResolve(string form, Scope scope, out string target)
    {
        target = "";
        if (form.Length == 0) return false;
        if (form[0] == '@') {
            target = form[1..];
            if (byId.TryGetValue(target, out var keyed)) { target = id[same[keyed]]; return true; }
            return outside.ContainsKey(target);
        }
        string? ofKind = null; var rest = form;
        var colon = form.IndexOf(':');
        if (colon > 0) { ofKind = form[..colon]; rest = form[(colon + 1)..]; }
        string? owner = null; var dot = rest.LastIndexOf('.');
        if (dot > 0) { owner = rest[..dot]; rest = rest[(dot + 1)..]; }
        var hits = Candidates(rest, ofKind, owner, scope);
        if (hits.Count != 1) return false;
        target = hits[0]; return true;
    }

    private static bool SafeName(string name) =>
        name.Length > 0 && !char.IsWhiteSpace(name[0]) && !char.IsWhiteSpace(name[^1]) && name[0] != '@'
        && name.IndexOfAny([',', '(', ')', '=', ':', '.', '"', '\'', '<', '>', '&', '\n', '\r', '\t', '{', '}']) < 0;

    // The first of Name, Kind:Name, Owner.Name, Kind:Owner.Name that resolves back to the target from this screen, else @id.
    internal string NameOf(string target, Scope scope)
    {
        string name, k; string? owner = null;
        if (byId.TryGetValue(target, out var i)) { i = same[i]; target = id[i]; name = display[i]; k = kind[i]; if (parent[i] >= 0) owner = display[parent[i]]; }
        else if (outside.TryGetValue(target, out var o)) { name = o.Name; k = o.Kind; }
        else return "@" + target;
        if (SafeName(name)) {
            if (TryResolve(name, scope, out var back) && back == target) return name;
            if (ScreenHtml.IsIdentifier(k) && TryResolve(k + ":" + name, scope, out back) && back == target) return k + ":" + name;
            if (owner != null && SafeName(owner) && TryResolve(owner + "." + name, scope, out back) && back == target) return owner + "." + name;
            if (ScreenHtml.IsIdentifier(k) && owner != null && SafeName(owner) && TryResolve(k + ":" + owner + "." + name, scope, out back) && back == target) return k + ":" + owner + "." + name;
        }
        return "@" + target;
    }

    // ---- the same names for the writer (ScreenDocument, B1) -----------------------------------------------------------------
    // The writer compiles a document into a root this reading does not hold: it answers tier 0 (its own elements) itself and
    // asks here for the other tiers, nearest first, with the reading's rules. A root to leave out (the screen a recreation
    // replaces) never answers.
    internal List<(T Node, string Kind, int Tier)> Lookup(string form, T? exclude)
    {
        var found = new List<(T Node, string Kind, int Tier)>();
        if (form.Length == 0 || form[0] == '@') return found;
        string? ofKind = null; var rest = form;
        var colon = form.IndexOf(':');
        if (colon > 0) { ofKind = form[..colon]; rest = form[(colon + 1)..]; }
        string? owner = null; var dot = rest.LastIndexOf('.');
        if (dot > 0) { owner = rest[..dot]; rest = rest[(dot + 1)..]; }
        var left = exclude != null && at.TryGetValue(exclude, out var e) ? e : -1;
        if (!byName.TryGetValue(rest, out var list)) return found;
        foreach (var i in list) {
            if (ofKind != null && kind[i] != ofKind) continue;
            if (owner != null && (parent[i] < 0 || !string.Equals(display[parent[i]], owner, StringComparison.OrdinalIgnoreCase))) continue;
            if (left >= 0 && (i == left || root[i] == left)) continue;
            found.Add((nodes[i], kind[i], Tier(i, -2)));
        }
        found.Sort((a, b) => a.Tier.CompareTo(b.Tier));
        return found;
    }
    // A node of the reading by its id (@key), or null.
    internal T? NodeOf(string id) => byId.TryGetValue(id, out var i) ? nodes[i] : null;
    // Every named node of the reading outside the left-out root: the candidates of the nearest name of a refusal.
    internal IEnumerable<(T Node, string Kind, string Name, string Role)> NamedNodes(T? exclude)
    {
        var left = exclude != null && at.TryGetValue(exclude, out var e) ? e : -1;
        for (var i = 0; i < nodes.Count; i++)
            if (display[i].Length > 0 && (left < 0 || i != left && root[i] != left)) yield return (nodes[i], kind[i], display[i], role[i]);
    }
    internal T ModuleNode => module;

    // A placeholder of the block an instance shows, by name: among the descendants of that block.
    private bool TryResolveUnder(int under, string name, Func<int, bool> accept, out string target)
    {
        target = "";
        var hits = new List<int>();
        foreach (var i in Descendants(under)) if (accept(i) && string.Equals(display[i], name, StringComparison.OrdinalIgnoreCase)) hits.Add(i);
        if (hits.Count != 1) return false;
        target = id[hits[0]]; return true;
    }
    private IEnumerable<int> Descendants(int under)
    {
        var stack = new Stack<int>(); stack.Push(under);
        while (stack.TryPop(out var node)) foreach (var c in childrenOf[node]) { yield return c; stack.Push(c); }
    }
    private int IndexOf(string target) => byId.TryGetValue(target, out var i) ? i : -1;
    // The children of a node in the order the text writes them. Widgets keep the model's order (it is the page). The
    // Model API gives every other collection in a different order on each load (actions, events, aggregates and their
    // sources, joins and filters, arguments): the members of an ordered list of the owner keep that list's order (a
    // signature's parameters, the variables, a sort order, the extended properties of a widget); the rest are a set,
    // written by kind, name and key. The same capture gives the same text in every process.
    private static readonly string[] OrderedLists = ["InputParameters", "OutputParameters", "LocalVariables", "Sorts", "ExtendedProperties"];
    private readonly Dictionary<int, int[]> canonical = [];
    private List<int> ChildIndexes(int i)
    {
        if (!canonical.TryGetValue(i, out var order)) {
            var all = childrenOf[i];
            var mine = new HashSet<int>(all);
            var placed = new List<int>(); var taken = new HashSet<int>();
            foreach (var property in OrderedLists) {
                if (r.PropertyOf(nodes[i], property) is not { } read) continue;
                object? value;
                try { value = read(); } catch { continue; }
                if (value is not IEnumerable items || value is string) continue;
                foreach (var item in items)
                    if (item is T t && at.TryGetValue(t, out var c) && mine.Contains(c) && role[c] != "widget" && taken.Add(c)) placed.Add(c);
            }
            // A member without a name (a block's event handler, an HTML event, a filter, a join) is ordered by what it says
            // before its key: the same page compiled again (new keys) reads in the same order.
            var set = all.Where(c => role[c] != "widget" && !taken.Contains(c))
                .OrderBy(c => kind[c], StringComparer.Ordinal).ThenBy(c => display[c], StringComparer.Ordinal)
                .ThenBy(c => display[c].Length == 0 ? Says(c) : "", StringComparer.Ordinal).ThenBy(c => key[c], StringComparer.Ordinal);
            canonical[i] = order = [.. placed, .. set, .. all.Where(c => role[c] == "widget")];
        }
        return [.. order];
    }

    // What an unnamed member says: the names it points at and the texts it holds, in a fixed order of properties.
    private static readonly string[] Saying = ["Event", "Handler", "Destination", "Parameter", "Property", "LeftSource", "RightSource", "Attribute", "Condition", "Value", "Source"];
    private string Says(int c)
    {
        var parts = new List<string>();
        foreach (var property in Saying) {
            if (r.PropertyOf(nodes[c], property) is not { } read) continue;
            object? value;
            try { value = read(); } catch { continue; }
            parts.Add(value switch { null => "", T target => r.DisplayOf(target), _ => r.ExpressionText(value) ?? (value is string s ? s : "") });
        }
        return string.Join("\u0001", parts);
    }

    // A fact at the default of its property where the element sits (inside a Popup: what the Studio gives it there, such as
    // the Popup's Transition of an event).
    private static bool IsDefault(ScreenDefaults defaults, string kd, Fact f, bool inPopup = false) => f.Text == defaults.DefaultOf(kd, f.Name, f.Type, inPopup);

    // Whether a node of the walk is a Popup or sits inside one (up to its screen or block).
    internal bool InPopup(int i)
    {
        for (var p = i; p >= 0; p = parent[p]) {
            if (kind[p] == "Popup") return true;
            if (role[p] is "screen" or "block") return false;
        }
        return false;
    }
    internal static string EventAttribute(string name) => "on" + (name.StartsWith("On", StringComparison.Ordinal) ? name[2..] : name).ToLowerInvariant();
    private static bool SafeAttribute(string name) => name.Length > 0 && char.IsLetter(name[0]) && name.All(c => char.IsLetterOrDigit(c) || c is '-' or '_');
    private static bool SimpleTag(string tag) =>
        tag.Length > 0 && tag[0] is >= 'a' and <= 'z' && tag.All(c => c is >= 'a' and <= 'z' or >= '0' and <= '9' or '-') && !tag.EndsWith('-');

    // ---- the writer ---------------------------------------------------------------------------------------------------------
    // Two passes: the first reads the model into the canonical form and a tree of elements whose reference values are
    // deferred; the second writes the text, once every element outside the walk that the document refers to is known (the
    // names it writes are resolved in that scope).
    private sealed class PNode
    {
        public string Tag = "";
        public readonly List<(string Name, Func<string>? Value)> Attrs = [];   // null value: a bare attribute (html, else)
        public readonly List<object> Children = [];                             // PNode, or one written line (string)
        public string? Content;                                                 // <text k>content</text>
        public readonly HashSet<string> Events = new(StringComparer.Ordinal);    // event attributes (on*, html:*, @*)
        public readonly HashSet<string> Extended = new(StringComparer.Ordinal);  // extended property attributes
    }

    private sealed class Writer(ScreenHtmlModule<T> m, int rootIndex)
    {
        public readonly StringBuilder Html = new();
        public readonly ScreenHtmlCanon Canon = new();
        public readonly List<KeyValuePair<string, string>> Keys = [];
        public readonly Dictionary<string, Shape> Shapes = new(StringComparer.Ordinal);
        public readonly Scope Scope = new(rootIndex);
        public int WidgetCount, OpaqueCount, ElementCount;
        // The defaults of the page: those of the UI flow it is in (ScreenHtmlModule.DefaultsOfRoot).
        private ScreenDefaults? defaults;
        private bool IsDefault(string kd, Fact f, bool inPopup = false) => ScreenHtmlModule<T>.IsDefault(defaults ??= m.DefaultsOfRoot(rootIndex), kd, f, inPopup);
        private int next;
        private string Next() => "w" + (++next).ToString(CultureInfo.InvariantCulture);
        private List<string> Problems => Canon.Problems;
        // The root element: its children start at column 0 (one level less of indentation on every line).
        private PNode? root;

        private List<Fact> Facts(int i, Shape shape, out Dictionary<string, T> pointers)
        {
            var facts = m.Facts(i, shape, Problems, out pointers);
            foreach (var f in facts)
                if (f.Type == 'r' && f.Text.StartsWith('~')) Scope.Outside.Add(f.Text);
                else if (f.Type == 'l') foreach (var t in f.Text.Split('\n')) if (t.StartsWith('~')) Scope.Outside.Add(t);
            return facts;
        }

        public void Run()
        {
            var i = rootIndex;
            var shape = new Shape { Kind = m.kind[i], Node = i };
            var facts = Facts(i, shape, out var pointers);
            var element = Element("", m.kind[i], shape);
            var top = new PNode { Tag = m.role[i] == "screen" ? "screen" : "block" };
            var children = m.ChildIndexes(i);
            Keys.Add(new("", m.key[i]));
            // The stylesheet of the screen or block is a <style> child, as it is (raw text up to </style>).
            var sheet = facts.FirstOrDefault(f => f.Name == "StyleSheet");
            var css = sheet.Name != null && sheet.Text.Length > 0 && !sheet.Text.Contains("</style>", StringComparison.Ordinal) ? sheet.Text : null;
            Encode(m.kind[i], facts.Where(f => css == null || f.Name != "StyleSheet").ToList(), top, element, ScreenHtmlModuleMode.Data);
            if (css != null) { element.Facts["p:StyleSheet"] = "t:" + css; top.Children.Add("<style>" + css + "</style>"); }
            Events(pointers, children, top, element, shape);
            var data = new List<int>(); var widgets = new List<int>();
            var actions = new List<string>(); var dataActions = new List<string>();
            foreach (var c in children) {
                if (m.role[c] == "expression" || m.role[c] == "event" && m.kind[c] != "BlockEvent" || m.kind[c] == "Argument") continue;
                // Actions belong to the logic text (ssam-flow): the page lists their names on the root, in model order.
                if (m.role[c] == "action") {
                    // A Traditional screen's Preparation has no name: it is listed by its kind.
                    var actionName = m.display[c].Length > 0 ? m.display[c] : m.kind[c];
                    (m.kind[c] == "DataAction" ? dataActions : actions).Add(actionName);
                    Keys.Add(new((m.kind[c] == "DataAction" ? "data-action:" : "action:") + actionName, m.key[c]));
                    if (!ScreenHtml.IsIdentifier(actionName)) Problems.Add("action name @" + m.id[c] + " '" + actionName + "'");
                    continue;
                }
                (m.role[c] == "widget" ? widgets : data).Add(c);
            }
            // Sets: by name.
            actions.Sort(StringComparer.Ordinal); dataActions.Sort(StringComparer.Ordinal);
            if (actions.Count > 0) { element.Facts["actions"] = string.Join("\n", actions); top.Attrs.Add(("actions", Const(string.Join(", ", actions)))); }
            if (dataActions.Count > 0) { element.Facts["data-actions"] = string.Join("\n", dataActions); top.Attrs.Add(("data-actions", Const(string.Join(", ", dataActions)))); }
            foreach (var c in data) WriteData(c, top, element.Children);
            foreach (var c in widgets) WriteWidget(c, "", top, element.Children);
            root = top; Render(top, "");
        }

        // The fixed order of the attributes: k and the markers, name, id, the table's attributes, class and style, os-* (by
        // name), the events with their properties, the arguments, the handlers, then the extended properties in model order.
        private static int Rank(PNode node, string name) =>
            node.Extended.Contains(name) ? 60
            : node.Events.Contains(name.Split('.')[0]) ? 40
            : name.StartsWith("os-", StringComparison.Ordinal) && node.Events.Contains(name[3..].Split('.')[0]) ? 41
            : name switch {
                "k" => 0, "html" or "tag" or "else" => 1, "name" => 3, "id" => 4, "actions" => 5, "data-actions" => 6, "class" => 20, "style" => 21,
                _ when name.StartsWith("os-", StringComparison.Ordinal) => 30,
                _ when name.StartsWith(':') => 50,
                _ when name.StartsWith('@') => 51,
                _ => 10 };

        private void Render(PNode node, string indent)
        {
            Html.Append(indent).Append('<').Append(node.Tag);
            var ordered = node.Attrs.Select((a, n) => (a, n, rank: Rank(node, a.Name)))
                .OrderBy(x => x.rank).ThenBy(x => x.rank == 30 ? x.a.Name : "", StringComparer.Ordinal).ThenBy(x => x.n).Select(x => x.a);
            foreach (var (name, value) in ordered) {
                Html.Append(' ');
                if (value == null) Html.Append(name); else Html.Append(ScreenHtml.Attribute(name, value()));
            }
            if (node.Content != null) { Html.Append('>').Append(ScreenHtml.EscapeLiteral(node.Content)).Append("</").Append(node.Tag).Append(">\n"); return; }
            if (node.Children.Count == 0) { Html.Append("/>\n"); return; }
            // One plain run (a text or {{ expression }}) is written inline: <a k="w3" onclick="Save">Save</a>.
            if (node.Children is [string run] && !run.StartsWith('<')) { Html.Append('>').Append(run).Append("</").Append(node.Tag).Append(">\n"); return; }
            Html.Append(">\n");
            var inner = node == root ? "" : indent + " ";
            foreach (var child in node.Children)
                if (child is PNode p) Render(p, inner); else Html.Append(inner).Append((string)child).Append('\n');
            Html.Append(indent).Append("</").Append(node.Tag).Append(">\n");
        }

        private ScreenHtmlCanon.Element Element(string k, string kindName, Shape shape)
        {
            var element = new ScreenHtmlCanon.Element { Kind = kindName };
            if (Canon.Elements.ContainsKey(k)) Problems.Add("duplicate element id " + k);
            Canon.Elements[k] = element;
            Shapes[k] = shape;
            return element;
        }

        private static Func<string> Const(string value) => () => value;

        // ---- data elements (inputs, variables, aggregates, actions, block events) and generic nodes -------------------
        private void WriteData(int i, PNode parentNode, List<string> parentChildren)
        {
            var kd = m.kind[i];
            var tag = kd switch {
                "InputParameter" => "input", "LocalVariable" => "var", "ScreenAggregate" => "aggregate", "DataAction" => "data-action",
                "BlockEvent" => "event", _ when m.role[i] == "action" => "action", _ => "os-" + kd };
            var k = Next(); ElementCount++;
            Keys.Add(new(k, m.key[i]));
            parentChildren.Add("k:" + k);
            var shape = new Shape { Kind = kd, Node = i };
            var element = Element(k, kd, shape);
            var node = new PNode { Tag = tag };
            node.Attrs.Add(("k", Const(k)));
            parentNode.Children.Add(node);
            if (tag is "action" or "data-action") {
                // Logic stays with the logic text (ssam-flow): the page names the action only.
                element.Facts["p:Name"] = "t:" + m.display[i];
                shape.Types["Name"] = 't';
                node.Attrs.Add(("name", Const(m.display[i])));
                return;
            }
            var facts = Facts(i, shape, out var pointers);
            Encode(kd, facts, node, element, ScreenHtmlModuleMode.Data);
            var children = m.ChildIndexes(i);
            Events(pointers, children, node, element, shape);
            Arguments(children, node, element);
            foreach (var c in children.Where(c => m.role[c] != "expression" && m.role[c] != "event" && m.kind[c] != "Argument"))
                WriteData(c, node, element.Children);
        }

        // ---- widgets -----------------------------------------------------------------------------------------------------
        private void WriteWidget(int i, string parentId, PNode parentNode, List<string> parentChildren)
        {
            var kd = m.kind[i];
            if (m.role[i] != "widget") { WriteData(i, parentNode, parentChildren); return; }
            if (ScreenHtml.OpaqueKinds.Contains(kd) || ScreenHtmlTables.TraditionalOnly.Contains(kd) && m.kind[Scope.Root] is not ("WebScreen" or "WebBlock") || !ScreenHtml.WidgetTags.ContainsKey(kd) && kd is not ("List" or "AdvancedHtml")) { Opaque(i, parentId, parentNode, parentChildren); return; }
            WidgetCount++;
            var shape = new Shape { Kind = kd, Node = i };
            var facts = Facts(i, shape, out var pointers);
            var children = m.ChildIndexes(i);
            var textFact = facts.FirstOrDefault(f => f.Name == "Text");
            if (kd == "TextWidget") facts.RemoveAll(f => f.Name == "Value" && textFact.Name != null && f.Text == textFact.Text);
            var own = facts.Where(f => !IsDefault(kd, f) && !(f.Name == "Style" && f.Type == 't' && Redundant(facts, f))).ToList();
            var carriers = children.Any(c => m.kind[c] is "ExtendedProperty" or "Argument" || m.role[c] is "widget" or "event");
            // A run: a text or an expression with nothing else of its own is one line of its parent.
            if (kd == "TextWidget" && !carriers && own.All(f => f.Name == "Text")) { Run(i, parentId, parentNode, parentChildren, textFact.Text ?? "", false); return; }
            if (kd is "Expression" or "ExpressionWidget" && !carriers && own.All(f => f.Name == "Value")) { Run(i, parentId, parentNode, parentChildren, own.FirstOrDefault().Text ?? "", true); return; }
            var k = Next(); ElementCount++;
            Keys.Add(new(k, m.key[i]));
            parentChildren.Add("k:" + k);
            var element = Element(k, kd, shape);
            var node = new PNode();
            node.Attrs.Add(("k", Const(k)));
            var tagText = facts.FirstOrDefault(f => f.Name == "Tag").Text ?? "";
            switch (kd) {
                case "AdvancedHtml": {
                    var simple = SimpleTag(tagText) && (!ScreenHtml.VoidTags.Contains(tagText) || !children.Any(c => m.role[c] == "widget"));
                    var reserved = ScreenHtml.ReservedTags.Contains(tagText) || m.kind[Scope.Root] is "WebScreen" or "WebBlock" && ScreenHtml.TraditionalTags.Contains(tagText);
                    if (simple && !reserved) node.Tag = tagText;
                    else if (simple) { node.Tag = tagText; node.Attrs.Add(("html", null)); }
                    else { node.Tag = "html-element"; node.Attrs.Add(("tag", Const(tagText))); }
                    element.Facts["p:Tag"] = "t:" + tagText;
                    facts.RemoveAll(f => f.Name == "Tag");
                    break;
                }
                case "List": {
                    // No Tag at all is the runtime's div; any other Tag, empty included, is what the element says.
                    var t = facts.Any(f => f.Name == "Tag") ? tagText : "div";
                    if (SimpleTag(t) && !ScreenHtml.VoidTags.Contains(t) && t != "list") node.Tag = t; else { node.Tag = "list"; node.Attrs.Add(("tag", Const(t))); }
                    if (t != "div") element.Facts["p:Tag"] = "t:" + t;
                    facts.RemoveAll(f => f.Name == "Tag");
                    break;
                }
                case "Checkbox": node.Tag = "input"; node.Attrs.Add(("type", Const("checkbox"))); break;
                default: node.Tag = ScreenHtml.WidgetTags[kd]; break;
            }
            if (kd == "TextWidget") { node.Content = textFact.Text ?? ""; facts.RemoveAll(f => f.Name == "Text"); element.Facts["text"] = node.Content; }
            // A native Table: the class of its header row and of its template row are those rows' (WriteTable).
            var rowStyles = kd == "TableRecords" ? facts.Where(f => f.Name is "StyleHeader" or "StyleRow").ToList() : null;
            if (rowStyles != null) facts.RemoveAll(f => f.Name is "StyleHeader" or "StyleRow");
            Encode(kd, facts, node, element, ScreenHtmlModuleMode.Widget);
            // A Table without Source (dragged in the Studio, not bound yet) is still the <table> of the language: list="" says so,
            // and it reads back as the Table (the review of round 1, B2).
            if (rowStyles != null && !element.Facts.ContainsKey("p:Source")) { element.Facts["p:Source"] = "e:"; node.Attrs.Add(("list", Const(""))); }
            Events(pointers, children, node, element, shape, m.InPopup(i));
            Arguments(children, node, element);
            Extended(children, node, element, kd);
            parentNode.Children.Add(node);
            if (kd == "TextWidget") { foreach (var c in children) if (m.role[c] == "widget") Problems.Add("text with widgets inside @" + m.id[c]); return; }
            if (kd == "IfWidget") { WriteIf(i, k, pointers, children, node, element, parentNode); return; }
            if (rowStyles != null) { WriteTable(i, k, children, node, element, rowStyles); return; }
            WriteChildren(k, children, node, element.Children);
        }

        // A native Table is the <table> of the language (ScreenHtmlTables.NativeTable): its HeaderRow the one <tr> of its <thead>,
        // its Row the one template <tr> of its <tbody>, StyleHeader and StyleRow the class of those rows. Each row is a group of the
        // canonical form (k/content:HeaderRow, k/content:Row) in that order, as any element with several contents. The rows are the
        // Table's HeaderRow and Row properties, whatever the platform calls them (O11: a MobileWidget headerRow and row; ODC: a
        // Content).
        private void WriteTable(int table, string k, List<int> children, PNode node, ScreenHtmlCanon.Element element, List<Fact> rowStyles)
        {
            var contents = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var name in new[] { "HeaderRow", "Row" })
                if (m.r.PropertyOf(m.nodes[table], name)?.Invoke() is T held && m.at.TryGetValue(held, out var index)) contents[name] = index;
            foreach (var c in children) {
                if (Carried(m, c) || contents.ContainsValue(c)) continue;
                Problems.Add("table child @" + m.id[c] + " " + m.kind[c]);
            }
            foreach (var (name, section, style) in new[] { ("HeaderRow", "thead", "StyleHeader"), ("Row", "tbody", "StyleRow") }) {
                var row = new PNode { Tag = "tr" };
                var group = new PNode { Tag = section };
                group.Children.Add(row);
                node.Children.Add(group);
                var f = rowStyles.FirstOrDefault(s => s.Name == style);
                if (f.Name != null && !IsDefault("TableRecords", f)) {
                    element.Facts["p:" + style] = f.Type + ":" + f.Text;
                    row.Attrs.Add(("class", Value("TableRecords", f, "class")));
                }
                if (!contents.TryGetValue(name, out var c)) { Problems.Add("table " + k + " without its " + name); continue; }
                // O11 lists a row as a widget of the Table (a MobileWidget): one of the page's widgets, represented by its <tr>; an
                // ODC row is a Content, as every content of an element, no widget of its own.
                if (m.role[c] == "widget" && m.kind[c] != "Content") WidgetCount++;
                CheckStructural(c, m.kind[c]);
                var cid = k + "/content:" + name;
                Keys.Add(new(cid, m.key[c]));
                element.Children.Add("c:" + name);
                var groupElement = Element(cid, "Content", new Shape { Kind = "Content", Node = c });
                foreach (var g in m.ChildIndexes(c)) if (!Carried(m, g)) WriteWidget(g, cid, row, groupElement.Children);
            }
        }

        internal static bool Redundant(List<Fact> facts, Fact style)
        {
            var classes = facts.FirstOrDefault(f => f.Name == "StyleClasses");
            return classes.Name != null ? style.Text == classes.Text : style.Text.Length == 0;
        }

        private void Run(int i, string parentId, PNode parentNode, List<string> parentChildren, string value, bool expression)
        {
            var ordinal = parentChildren.Count(c => c.StartsWith("t:", StringComparison.Ordinal) || c.StartsWith("x:", StringComparison.Ordinal));
            Keys.Add(new(parentId + "~" + ordinal.ToString(CultureInfo.InvariantCulture), m.key[i]));
            if (expression) {
                parentChildren.Add("x:" + value);
                parentNode.Children.Add("{{ " + ScreenHtml.Escape(value, true) + " }}");
            } else {
                parentChildren.Add("t:" + value);
                parentNode.Children.Add(ScreenHtml.PlainRun(value) ? ScreenHtml.Escape(value, true) : "<text>" + ScreenHtml.EscapeLiteral(value) + "</text>");
            }
        }

        // An opaque node: kind and name only, untouchable. A table keeps the widgets of its rows and cells written inside it;
        // any other kind hides its whole subtree (and every widget in it counts as opaque).
        private void Opaque(int i, string parentId, PNode parentNode, List<string> parentChildren)
        {
            var k = Next(); ElementCount++;
            Keys.Add(new(k, m.key[i]));
            parentChildren.Add("k:" + k);
            var element = Element(k, "os-opaque", new Shape { Kind = "os-opaque", Node = i });
            element.Facts["kind"] = m.kind[i];
            element.Facts["name"] = m.display[i];
            var node = new PNode { Tag = "os-opaque" };
            node.Attrs.Add(("k", Const(k))); node.Attrs.Add(("kind", Const(m.kind[i])));
            if (m.display[i].Length > 0) node.Attrs.Add(("name", Const(m.display[i])));
            parentNode.Children.Add(node);
            if (ScreenHtml.OpaqueWithChildren.Contains(m.kind[i])) {
                OpaqueCount++; WidgetCount++;
                WriteChildren(k, m.ChildIndexes(i), node, element.Children);
                return;
            }
            var count = m.role[i] == "widget" ? 1 : 0;
            foreach (var d in m.Descendants(i)) if (m.role[d] == "widget" && m.kind[d] is not ("IfBranchWidget" or "PlaceholderContentWidget" or "Content")) count++;
            OpaqueCount += count; WidgetCount += count;
        }

        private static bool Carried(ScreenHtmlModule<T> m, int c) => m.role[c] == "expression" || m.kind[c] is "ExtendedProperty" or "Argument" || m.role[c] == "event";

        private void WriteChildren(string k, List<int> children, PNode node, List<string> canonChildren)
        {
            var contents = children.Count(c => m.kind[c] == "Content");
            foreach (var c in children) {
                var kd = m.kind[c];
                if (Carried(m, c)) continue;
                if (kd == "Content") {
                    CheckStructural(c, "Content");
                    if (contents == 1) {
                        Keys.Add(new(k + ".content", m.key[c]));
                        foreach (var g in m.ChildIndexes(c)) if (!Carried(m, g)) WriteWidget(g, k, node, canonChildren);
                    } else {
                        var cid = k + "/content:" + m.display[c];
                        Keys.Add(new(cid, m.key[c]));
                        canonChildren.Add("c:" + m.display[c]);
                        var group = Element(cid, "Content", new Shape { Kind = "Content", Node = c });
                        var groupNode = new PNode { Tag = "content" };
                        groupNode.Attrs.Add(("name", Const(m.display[c])));
                        node.Children.Add(groupNode);
                        foreach (var g in m.ChildIndexes(c)) if (!Carried(m, g)) WriteWidget(g, cid, groupNode, group.Children);
                    }
                    continue;
                }
                if (kd == "PlaceholderContentWidget") { WriteSlot(c, k, node, canonChildren); continue; }
                WriteWidget(c, k, node, canonChildren);
            }
        }

        // A Content or an If branch holds only widgets; its own properties are structure (name "content"). Anything else on
        // it is reported, never dropped.
        private void CheckStructural(int c, string kd)
        {
            foreach (var f in Facts(c, new Shape(), out _))
                if (f.Name != "Name" && !IsDefault(kd, f)) Problems.Add(kd + " property @" + m.id[c] + " " + f.Name + "=" + f.Text);
        }

        private void WriteSlot(int c, string k, PNode parentNode, List<string> canonChildren)
        {
            var shape = new Shape { Kind = "PlaceholderContentWidget", Node = c };
            var facts = Facts(c, shape, out _);
            var placeholder = facts.FirstOrDefault(f => f.Name == "Placeholder").Text ?? "";
            var name = m.IndexOf(placeholder) is var p and >= 0 ? m.display[p] : placeholder.StartsWith('~') ? placeholder[(placeholder.IndexOf(':') + 1)..] : m.display[c];
            var sid = k + "/" + name;
            Keys.Add(new(sid, m.key[c]));
            canonChildren.Add("s:" + name);
            var element = Element(sid, "PlaceholderContentWidget", shape);
            element.Facts["placeholder"] = placeholder;
            shape.SlotName = name; shape.SlotPlaceholder = placeholder;
            var node = new PNode { Tag = "slot" };
            node.Attrs.Add(("name", Const(name)));
            foreach (var f in facts) {
                if (f.Name == "Placeholder" || f.Name == "Name" && string.Equals(f.Text, name, StringComparison.Ordinal) || IsDefault("PlaceholderContentWidget", f)) continue;
                element.Facts["p:" + f.Name] = f.Type + ":" + f.Text;
                node.Attrs.Add(("os-" + f.Name, Value("PlaceholderContentWidget", f, "")));
            }
            if (!facts.Any(f => f.Name == "Name") && name.Length > 0) { element.Facts["p:Name"] = "?:"; node.Attrs.Add(("os-Name", Const(""))); }
            parentNode.Children.Add(node);
            WriteChildren(sid, m.ChildIndexes(c), node, element.Children);
        }

        private void WriteIf(int i, string k, Dictionary<string, T> pointers, List<int> children, PNode node, ScreenHtmlCanon.Element element, PNode parentNode)
        {
            int? Branch(string property) => pointers.TryGetValue(property, out var b) && m.at.TryGetValue(b, out var bi) ? bi : null;
            var branches = children.Where(c => m.kind[c] == "IfBranchWidget").ToList();
            if (branches.Count != 2) { Problems.Add("if without two branches @" + m.id[i]); if (branches.Count == 0) return; }
            var trueBranch = Branch("TrueBranch") ?? branches[0];
            var falseBranch = Branch("FalseBranch") ?? branches[^1];
            foreach (var c in children) if (m.role[c] == "widget" && m.kind[c] != "IfBranchWidget") Problems.Add("if child outside its branches @" + m.id[c]);
            Keys.Add(new(k + ".true", m.key[trueBranch]));
            CheckStructural(trueBranch, "IfBranchWidget");
            WriteChildren(k, m.ChildIndexes(trueBranch), node, element.Children);
            element.Children.Add("else");
            Keys.Add(new(k + ".false", m.key[falseBranch]));
            CheckStructural(falseBranch, "IfBranchWidget");
            var other = new PNode { Tag = "div" };
            other.Attrs.Add(("else", null));
            WriteChildren(k, m.ChildIndexes(falseBranch), other, element.Children);
            if (other.Children.Count > 0) parentNode.Children.Add(other);
        }

        // ---- encoding of facts as attributes -------------------------------------------------------------------------------
        private void Encode(string kd, List<Fact> facts, PNode node, ScreenHtmlCanon.Element element, ScreenHtmlModuleMode mode)
        {
            var hasClasses = facts.Any(x => x.Name == "StyleClasses");
            foreach (var f in facts) {
                if (IsDefault(kd, f)) continue;
                if (f.Name == "Style" && f.Type == 't' && Redundant(facts, f)) continue;
                element.Facts["p:" + f.Name] = f.Type + ":" + f.Text;
                var attribute = ScreenHtmlTables.AttributeOf(kd, f.Name, mode, hasClasses);
                if (node.Attrs.Any(a => a.Name == attribute)) Problems.Add("attribute twice " + attribute + " (" + f.Name + ") on " + kd);
                node.Attrs.Add((attribute, Value(kd, f, attribute)));
            }
        }

        private Func<string> Value(string kd, Fact f, string attribute) => f.Type switch {
            'e' when attribute == "class" => Const(ScreenHtml.Sugar(f.Text)),
            // An expression whose text holds a brace pair of a binding ("{{" inside a string) is written whole: the decoder reads a
            // value with a binding as the binding's expression (Decode), and the whole form is exactly the text.
            'e' when ScreenHtml.HoldsBraces(f.Text) => Const("{{ " + f.Text + " }}"),
            'r' => () => m.NameOf(f.Text, Scope),
            'l' => () => string.Join(", ", f.Text.Split('\n').Select(t => m.NameOf(t, Scope))),
            'v' when kd == "Input" && f.Name == "InputType" => Const(ScreenHtmlTables.InputTypeOut(f.Text)),
            _ => Const(f.Text) };

        // ---- events, arguments, extended properties ------------------------------------------------------------------------
        private void Events(Dictionary<string, T> pointers, List<int> children, PNode node, ScreenHtmlCanon.Element element, Shape shape, bool inPopup = false)
        {
            var named = new Dictionary<int, string>();
            foreach (var (property, target) in pointers)
                if (m.at.TryGetValue(target, out var e) && m.role[e] == "event") { named[e] = property; shape.NativeEvents[EventAttribute(property)] = property; }
            foreach (var e in children) {
                if (m.role[e] != "event" || m.kind[e] == "BlockEvent") continue;
                var ek = m.kind[e];
                var eshape = new Shape { Kind = ek, Node = e };
                var facts = Facts(e, eshape, out _);
                var arguments = ArgumentList(m.ChildIndexes(e).Where(x => m.kind[x] == "Argument").ToList());
                foreach (var x in m.ChildIndexes(e)) if (m.kind[x] is not ("Argument" or "InputParameter") && m.role[x] != "expression") Problems.Add("event child @" + m.id[x] + " " + m.kind[x]);
                string attribute, prefix;
                var destinationFact = facts.FirstOrDefault(f => f.Name is "Destination" or "Handler");
                if (ek == "EventHandler") {
                    var ev = facts.FirstOrDefault(f => f.Name == "Event").Text ?? "";
                    var name = m.IndexOf(ev) is var x and >= 0 ? m.display[x] : ev.StartsWith('~') ? ev[(ev.IndexOf(':') + 1)..] : ev;
                    attribute = "@" + name; prefix = "h:" + name;
                } else if (ek == "Event") {
                    var name = facts.FirstOrDefault(f => f.Name == "Event").Text ?? "";
                    attribute = shape.NativeEvents.ContainsKey(name) || !SafeAttribute(name) || !name.StartsWith("on", StringComparison.Ordinal) ? "html:" + name : name;
                    prefix = "hev:" + name;
                } else {
                    var name = named.TryGetValue(e, out var p) ? p : m.display[e];
                    attribute = EventAttribute(name);
                    shape.NativeEvents[attribute] = name;
                    prefix = "ev:" + name;
                }
                if (element.Facts.Keys.Any(f => f == prefix || f.StartsWith(prefix + ":", StringComparison.Ordinal))) Problems.Add("event twice " + prefix + " @" + m.id[e]);
                shape.EventTypes[prefix] = eshape.Types;
                node.Events.Add(attribute);
                foreach (var f in facts) {
                    if (f.Name is "Name" or "Destination" or "Handler" or "Event") continue;
                    if (f.Name == "Target" && destinationFact.Name != null && f.Text == destinationFact.Text) continue;
                    if (IsDefault(ek, f, inPopup)) continue;
                    element.Facts[prefix + ":p:" + f.Name] = f.Type + ":" + f.Text;
                    // An event's property is read back as written (EventProperty): never wrapped.
                    node.Attrs.Add(("os-" + attribute + "." + f.Name, f.Type is 'r' or 'l' ? Value(ek, f, "") : Const(f.Text)));
                }
                var destination = destinationFact.Name != null ? destinationFact.Text : "";
                if (destination.Length == 0 && arguments.Count == 0) continue;
                element.Facts[prefix] = destination;
                foreach (var (param, value) in arguments) element.Facts[prefix + ":a:" + param] = value;
                Func<string> target = destination.Length == 0 ? Const("") : () => m.NameOf(destination, Scope);
                // A target name never holds '(' or ','; whether the arguments survive the call form depends on them only.
                node.Events.Add(attribute);
                if (ScreenHtml.TryCall(ScreenHtml.Call("X", arguments), out var back, out var parsed) && back == "X" && parsed.SequenceEqual(arguments))
                    node.Attrs.Add((attribute, () => ScreenHtml.Call(target(), arguments)));
                else {
                    node.Attrs.Add((attribute, target));
                    foreach (var (param, value) in arguments) node.Attrs.Add((attribute + "." + param, Const(value)));
                }
            }
        }

        private List<(string Param, string Value)> ArgumentList(List<int> args)
        {
            var list = new List<(string, string)>();
            foreach (var a in args) {
                string param = "", value = "";
                foreach (var (name, read) in m.r.PropertiesOf(m.nodes[a])) {
                    if (name is not ("Parameter" or "Value")) continue;
                    object? v; try { v = read(); } catch (Exception error) { Problems.Add("read error @" + m.id[a] + " " + name + ": " + error.GetBaseException().Message); continue; }
                    if (name == "Parameter") param = v is T p ? m.r.DisplayOf(p) : v?.ToString() ?? "";
                    else value = v == null ? "" : m.r.ExpressionText(v) ?? v.ToString() ?? "";
                }
                foreach (var f in Facts(a, new Shape(), out _))
                    if (f.Name is not ("Parameter" or "Value") && !IsDefault("Argument", f)) Problems.Add("argument property @" + m.id[a] + " " + f.Name + "=" + f.Text);
                if (value.Length == 0) continue;
                if (list.Any(x => x.Item1 == param)) Problems.Add("argument twice @" + m.id[a] + " " + param);
                if (!ScreenHtml.IsIdentifier(param)) Problems.Add("argument name @" + m.id[a] + " '" + param + "'");
                list.Add((param, value));
            }
            // Named, and a set: the Model API gives them in a different order on each load.
            list.Sort((a, b) => string.CompareOrdinal(a.Item1, b.Item1));
            return list;
        }

        private void Arguments(List<int> children, PNode node, ScreenHtmlCanon.Element element)
        {
            foreach (var (param, value) in ArgumentList(children.Where(c => m.kind[c] == "Argument").ToList())) {
                element.Facts["a:" + param] = value;
                node.Attrs.Add((":" + param, Const(value)));
            }
        }

        private void Extended(List<int> children, PNode node, ScreenHtmlCanon.Element element, string kd)
        {
            var n = 0;
            foreach (var c in children) {
                if (m.kind[c] != "ExtendedProperty") continue;
                string property = "", value = "";
                foreach (var f in Facts(c, new Shape(), out _)) {
                    if (f.Name == "Property") property = f.Text;
                    else if (f.Name == "Value") value = f.Text;
                    else if (f.Name != "Name" && !IsDefault("ExtendedProperty", f)) Problems.Add("extended property field @" + m.id[c] + " " + f.Name + "=" + f.Text);
                }
                element.Facts["x:" + (n++).ToString("D3", CultureInfo.InvariantCulture)] = property + "\n" + value;
                var taken = node.Attrs.Any(a => a.Name == property) || ScreenHtmlTables.Reserved(kd, property) || !SafeAttribute(property);
                if (taken && (!SafeAttribute(property) || node.Attrs.Any(a => a.Name == "ext:" + property))) Problems.Add("extended property name @" + m.id[c] + " '" + property + "'");
                node.Attrs.Add(((taken ? "ext:" : "") + property, Const(ScreenHtml.Sugar(value))));
                node.Extended.Add((taken ? "ext:" : "") + property);
            }
        }
    }

    // ---- the decoder: the text back to the canonical form, with the reading's names and shapes ----------------------------
    private sealed class Decoder(ScreenHtmlModule<T> m, Scope scope, Dictionary<string, Shape> shapes)
    {
        private readonly ScreenHtmlCanon canon = new();
        private int created;
        // The id each element node of the text got (its k, or +n for a new one, in the order of the text): C2 maps a node of
        // the merged edit to its canonical element with it.
        public readonly Dictionary<ScreenHtml.Node, string> NodeIds = new(ReferenceEqualityComparer.Instance);

        public ScreenHtmlCanon Run(ScreenHtml.Node document)
        {
            var roots = document.Children.Where(c => !c.IsText || c.Text!.Trim().Length > 0).ToList();
            if (roots.Count != 1 || roots[0].Tag is not ("screen" or "block")) { canon.Problems.Add("the document must be one <screen> or <block>"); return canon; }
            // The root is read through a view of it: the text is never changed (an edit decodes the same tree more than once).
            var top = new ScreenHtml.Node { Tag = roots[0].Tag, Line = roots[0].Line, Column = roots[0].Column };
            top.Attributes.AddRange(roots[0].Attributes); top.Children.AddRange(roots[0].Children);
            var shape = shapes[""];
            var element = Element("", shape.Kind);
            foreach (var list in new[] { "actions", "data-actions" })
                if (top.Get(list) is { } names) { element.Facts[list] = string.Join("\n", names.Split(", ").Order(StringComparer.Ordinal)); top.Attributes.RemoveAll(a => a.Key == list); }
            DecodeAttributes(top, element, shape, ScreenHtmlModuleMode.Data, shape.Kind);
            var style = top.Children.Where(c => c.Tag == "style").ToList();
            if (style.Count > 1) canon.Problems.Add("more than one <style>");
            foreach (var sheet in style) { element.Facts["p:StyleSheet"] = "t:" + string.Concat(sheet.Children.Select(c => c.Text)); top.Children.Remove(sheet); }
            DecodeChildren(top, "", element.Children);
            return canon;
        }

        private ScreenHtmlCanon.Element Element(string k, string kindName)
        {
            var element = new ScreenHtmlCanon.Element { Kind = kindName };
            if (canon.Elements.ContainsKey(k)) canon.Problems.Add("k used twice: " + k);
            canon.Elements[k] = element;
            return element;
        }

        private string KeyOf(ScreenHtml.Node node)
        {
            var k = node.Get("k") ?? "+" + (++created).ToString(CultureInfo.InvariantCulture);
            NodeIds[node] = k;
            return k;
        }
        private Shape ShapeOf(string k) => shapes.TryGetValue(k, out var s) ? s : new Shape();

        private void DecodeNode(ScreenHtml.Node node, string parentId, List<string> parentChildren)
        {
            switch (node.Tag) {
                case "input" when node.Get("name") != null && node.Get("bind") == null:
                case "var": case "aggregate": case "data-action": case "action": case "event":
                    DecodeData(node, parentChildren); return;
                case "os-opaque": {
                    var k = KeyOf(node); parentChildren.Add("k:" + k);
                    var element = Element(k, "os-opaque");
                    element.Facts["kind"] = node.Get("kind") ?? "";
                    element.Facts["name"] = node.Get("name") ?? "";
                    foreach (var a in node.Attributes) if (a.Key is not ("k" or "kind" or "name")) canon.Problems.Add("os-opaque takes only k, kind and name: " + a.Key);
                    DecodeChildren(node, k, element.Children);
                    return;
                }
                case "text" when node.Get("k") == null:
                    parentChildren.Add("t:" + string.Concat(node.Children.Select(c => c.Text)));
                    return;
            }
            if (node.Tag.StartsWith("os-", StringComparison.Ordinal)) { DecodeData(node, parentChildren); return; }
            DecodeWidget(node, parentChildren);
        }

        private void DecodeData(ScreenHtml.Node node, List<string> parentChildren)
        {
            var k = KeyOf(node); parentChildren.Add("k:" + k);
            var shape = ShapeOf(k);
            var kd = node.Tag switch {
                "input" => "InputParameter", "var" => "LocalVariable", "aggregate" => "ScreenAggregate", "data-action" => "DataAction",
                "event" => "BlockEvent", "action" => shape.Kind.Length > 0 ? shape.Kind : "ScreenAction", _ => node.Tag[3..] };
            var element = Element(k, kd);
            if (node.Tag is "action" or "data-action") {
                element.Facts["p:Name"] = "t:" + (node.Get("name") ?? "");
                foreach (var a in node.Attributes) if (a.Key is not ("k" or "name")) canon.Problems.Add("<" + node.Tag + "> takes only k and name: " + a.Key);
                return;
            }
            DecodeAttributes(node, element, shape, ScreenHtmlModuleMode.Data, kd);
            foreach (var child in node.Children) {
                if (child.IsText) { if (child.Text!.Trim().Length > 0) canon.Problems.Add("text inside <" + node.Tag + "> at line " + child.Line); continue; }
                DecodeData(child, element.Children);
            }
        }

        private void DecodeWidget(ScreenHtml.Node node, List<string> parentChildren)
        {
            var kd = KindOf(node, out var tagText);
            var k = KeyOf(node); parentChildren.Add("k:" + k);
            var element = Element(k, kd);
            var shape = ShapeOf(k);
            if (kd is "AdvancedHtml") element.Facts["p:Tag"] = "t:" + tagText;
            if (kd is "List" && tagText != "div") element.Facts["p:Tag"] = "t:" + tagText;
            DecodeAttributes(node, element, shape, ScreenHtmlModuleMode.Widget, kd);
            if (kd == "TextWidget") { element.Facts["text"] = string.Concat(node.Children.Select(c => c.Text)); return; }
            if (kd == "TableRecords" && ScreenHtmlTables.NativeTable(node) is { } table) { DecodeTable(table, k, element, shape); return; }
            DecodeChildren(node, k, element.Children);
            if (kd == "IfWidget") element.Children.Add("else");
        }

        // A native Table (ScreenHtmlTables.NativeTable): its list wherever the text writes it, the class of its header row and of its
        // template row its StyleHeader and StyleRow, each row the Content group of the reading (k/content:HeaderRow, k/content:Row).
        // The List's own attributes beside the list are left out (a Table renders every row); any other attribute of a part is a
        // problem: the Table has no property for it.
        private void DecodeTable(ScreenHtmlTables.NativeTableShape table, string k, ScreenHtmlCanon.Element element, Shape shape)
        {
            if (!ReferenceEquals(table.SourceAt, table.Table)) {
                var type = TypeOf(shape, "Source");
                element.Facts["p:Source"] = type + ":" + Decode(shape, "Source", type, table.Source, "list");
                if (type is 'r' or 'l') element.Raw["p:Source"] = table.Source;
            }
            // A column is one header cell and one row cell: the platform removes and adds them together (deleting a header cell
            // deletes its column), so a text with more of one is no Table the module can hold.
            if (table.HeaderCells.Count != table.RowCells.Count) canon.Problems.Add(ScreenHtmlTables.HalfColumn(table));
            foreach (var (name, header, row, style) in new[] { ("HeaderRow", true, table.HeadRow, "StyleHeader"), ("Row", false, table.BodyRow, "StyleRow") }) {
                // The class of the row: its section's and its <tr>'s (ScreenHtmlTables.RowClass).
                if (ScreenHtmlTables.RowClass(table, header) is { } rowClass) {
                    var type = TypeOf(shape, style);
                    element.Facts["p:" + style] = type + ":" + Decode(shape, style, type, rowClass, "class");
                }
                foreach (var (part, attribute) in ScreenHtmlTables.PartAttributes(table, header))
                    canon.Problems.Add("<" + part.Tag + "> of a native Table at line " + part.Line.ToString(CultureInfo.InvariantCulture) + " has " + attribute + ": "
                        + ScreenHtmlTables.PartAttributeWhy);
                element.Children.Add("c:" + name);
                var id = k + "/content:" + name;
                var group = Element(id, "Content");
                DecodeChildren(row, id, group.Children);
            }
        }

        // <div else> right after a <div if>: its children continue the If's list after the "else" marker.
        private void DecodeChildren(ScreenHtml.Node node, string k, List<string> children)
        {
            ScreenHtmlCanon.Element? lastIf = null;
            var runs = ScreenHtml.Runs(node).ToLookup(r => r.Source, ReferenceEqualityComparer.Instance);
            foreach (var child in node.Children) {
                if (child.IsText) {
                    // One run per line (the whitespace beside an inline element kept, ScreenHtml.Runs): "{{ x }}" is x; literal
                    // text with bindings is their concatenation (ScreenHtml.Run).
                    foreach (var run in runs[child]) {
                        var value = ScreenHtml.Run(run.Text, out var expression, out var fault);
                        if (fault != null) canon.Problems.Add("a binding of the text at line " + run.Line.ToString(CultureInfo.InvariantCulture) + ": " + fault + " (write {{ expression }}, or <text> for literal braces)");
                        children.Add((expression ? "x:" : "t:") + value);
                        lastIf = null;
                    }
                    continue;
                }
                if (child.Tag == "div" && child.Attributes.Count == 1 && child.Attributes[0].Key == "else") {
                    if (lastIf == null) { canon.Problems.Add("<div else> without a <div if> right before it at line " + child.Line); continue; }
                    DecodeChildren(child, k, lastIf.Children);
                    lastIf = null;
                    continue;
                }
                lastIf = null;
                if (child.Tag == "slot") {
                    var name = child.Get("name") ?? "";
                    var sid = k + "/" + name;
                    children.Add("s:" + name);
                    var slot = Element(sid, "PlaceholderContentWidget");
                    var shape = ShapeOf(sid);
                    slot.Facts["placeholder"] = SlotPlaceholder(shape, name);
                    foreach (var a in child.Attributes) {
                        if (a.Key == "name") continue;
                        // os-Name="": a slot whose Name is null (its name is its placeholder's), as the reading writes it.
                        if (a.Key == "os-Name" && a.Value.Length == 0 && (!shape.Types.TryGetValue("Name", out var named) || named == '?')) slot.Facts["p:Name"] = "?:";
                        else if (a.Key.StartsWith("os-", StringComparison.Ordinal)) { var p = a.Key[3..]; var t = TypeOf(shape, p); slot.Facts["p:" + p] = t + ":" + Decode(shape, p, t, a.Value, ""); }
                        else canon.Problems.Add("unknown attribute " + a.Key + " on <slot> at line " + child.Line);
                    }
                    DecodeChildren(child, sid, slot.Children);
                    continue;
                }
                if (child.Tag == "content") {
                    var name = child.Get("name") ?? "";
                    children.Add("c:" + name);
                    var group = Element(k + "/content:" + name, "Content");
                    DecodeChildren(child, k + "/content:" + name, group.Children);
                    continue;
                }
                DecodeNode(child, k, children);
                if (child.Tag == "div" && child.Get("if") != null && children.Count > 0 && children[^1].StartsWith("k:", StringComparison.Ordinal))
                    lastIf = canon.Elements[children[^1][2..]];
            }
        }

        // The placeholder a slot names: the one it held when read under the same name, else by name under the block the
        // instance shows.
        private string SlotPlaceholder(Shape shape, string name)
        {
            if (shape.SlotName != null && string.Equals(shape.SlotName, name, StringComparison.OrdinalIgnoreCase)) return shape.SlotPlaceholder ?? "";
            if (shape.Node < 0) return "?" + name;
            var instance = m.parent[shape.Node];
            var source = instance < 0 ? null : m.Facts(instance, new Shape(), [], out _).FirstOrDefault(f => f.Name == "SourceBlock").Text;
            var under = source == null ? -1 : m.IndexOf(source);
            if (under >= 0 && m.TryResolveUnder(under, name, i => m.kind[i].Contains("Placeholder", StringComparison.Ordinal), out var target)) return target;
            var own = m.Facts(shape.Node, new Shape(), [], out _).FirstOrDefault(f => f.Name == "Placeholder").Text ?? "";
            var ownName = m.IndexOf(own) is var p and >= 0 ? m.display[p] : own.StartsWith('~') ? own[(own.IndexOf(':') + 1)..] : "";
            return string.Equals(ownName, name, StringComparison.OrdinalIgnoreCase) ? own : "?" + name;
        }

        private string KindOf(ScreenHtml.Node node, out string tagText)
        {
            var kind = ScreenHtmlTables.KindOf(node, out tagText);
            if (m.kind[scope.Root] is not ("WebScreen" or "WebBlock")) return kind;
            return node.Tag switch {
                "table" => "TableWidget", "table-records" => "TableRecordsWidget", "list-records" => "ListRecordsWidget",
                "tr" => "RowWidget", "td" => "CellWidget", "password-input" => "InputPasswordWidget",
                "checkbox-input" => "CheckBoxWidget", "radio-input" => "RadioButtonWidget", "edit-record" => "EditRecordWidget", "show-record" => "ShowRecordWidget",
                _ => ScreenHtmlTables.TraditionalKind(kind)
            };
        }

        private void DecodeAttributes(ScreenHtml.Node node, ScreenHtmlCanon.Element element, Shape shape, ScreenHtmlModuleMode mode, string kd)
        {
            var ext = 0;
            var reverse = ScreenHtmlTables.Reverse(kd, mode);
            foreach (var (name, value) in node.Attributes) {
                if (name is "k" or "html") continue;
                if (name == "tag" && (node.Tag is "html-element" || node.Tag == "list" && kd == "List")) continue;
                if (name == "type" && kd is "Checkbox") continue;
                if (name.StartsWith(':')) { element.Facts["a:" + name[1..]] = value; continue; }
                if (name.StartsWith("ext:", StringComparison.Ordinal)) { element.Facts["x:" + (ext++).ToString("D3", CultureInfo.InvariantCulture)] = name[4..] + "\n" + Sugared(name, value); continue; }
                if (name.StartsWith("os-", StringComparison.Ordinal) && EventProperty(name[3..], shape, element, value)) continue;
                if (EventAttribute(name, value, shape, element)) continue;
                string? property = reverse.TryGetValue(name, out var p) ? p : name.StartsWith("os-", StringComparison.Ordinal) ? name[3..] : null;
                // Some Traditional controls (the legacy selector) expose Style, not StyleClasses.
                // Mirror the writer's actual property choice instead of inventing a change on readback.
                if (name == "class" && property == "StyleClasses" && !shape.Types.ContainsKey("StyleClasses") && shape.Types.ContainsKey("Style")) property = "Style";
                // The Traditional custom Form has no class property: the native setter stores
                // it as an extended attribute. Do not invent a Style fact that cannot read back.
                if (name == "class" && kd == "Form" && m.kind[scope.Root] is "WebScreen" or "WebBlock"
                    && !shape.Types.ContainsKey("Style") && !shape.Types.ContainsKey("StyleClasses")) property = null;
                if (property != null) {
                    var type = TypeOf(shape, property);
                    element.Facts["p:" + property] = type + ":" + Decode(shape, property, type, value, name);
                    if (type is 'r' or 'l') element.Raw["p:" + property] = value;
                    continue;
                }
                element.Facts["x:" + (ext++).ToString("D3", CultureInfo.InvariantCulture)] = name + "\n" + Sugared(name, value);
            }
        }

        // A literal attribute value with its bindings (ScreenHtml.Unsugar); a malformed one is a problem of the text.
        private string Sugared(string attribute, string value)
        {
            if (ScreenHtml.BindingFault(value) is { } fault) canon.Problems.Add("a binding of " + attribute + ": " + fault + " (write {{ expression }})");
            return ScreenHtml.Unsugar(value);
        }

        private static char TypeOf(Shape shape, string property) =>
            shape.Types.TryGetValue(property, out var t) && t != '?' ? t : shape.NullTypes.TryGetValue(property, out var declared) ? declared : 'e';

        private string Decode(Shape shape, string property, char type, string value, string attribute) => type switch {
            'e' when attribute == "class" => Sugared(attribute, value),
            // Any expression attribute with a binding is the binding's expression ("Buscar {{ X }}" is "Buscar " + X; {{ x }} is x),
            // as class is; the reading writes an expression with braces of its own whole ({{ text }}), so it reads back exactly.
            'e' when ScreenHtml.HoldsBraces(value) => Sugared(attribute.Length > 0 ? attribute : "os-" + property, value),
            'r' when property == "SourceBlock" => m.TryResolveBlock(value, scope, out var block) ? block : "?" + value,
            'r' => m.TryResolve(value, scope, out var target) ? target : "?" + value,
            'l' => string.Join("\n", value.Split(", ").Select(v => m.TryResolve(v, scope, out var t) ? t : "?" + v).Order(StringComparer.Ordinal)),
            'v' when shape.Kind == "Input" && property == "InputType" => ScreenHtmlTables.InputTypeIn(value),
            _ => value };

        // os-on<event>.<Property>, os-@<Event>.<Property>, os-html:<event>.<Property>
        private bool EventProperty(string rest, Shape shape, ScreenHtmlCanon.Element element, string value)
        {
            var dot = rest.IndexOf('.');
            if (dot <= 0) return false;
            var prefix = EventPrefix(rest[..dot], shape);
            if (prefix == null) return false;
            var property = rest[(dot + 1)..];
            var types = shape.EventTypes.TryGetValue(prefix, out var t) ? t : new Dictionary<string, char>();
            var type = types.TryGetValue(property, out var tc) && tc != '?' ? tc : 'v';
            element.Facts[prefix + ":p:" + property] = type + ":" + (type == 'r' ? m.TryResolve(value, scope, out var target) ? target : "?" + value : value);
            return true;
        }

        private static string? EventPrefix(string attribute, Shape shape)
        {
            if (attribute.StartsWith('@')) return "h:" + attribute[1..];
            if (attribute.StartsWith("html:", StringComparison.Ordinal)) return "hev:" + attribute[5..];
            if (shape.NativeEvents.TryGetValue(attribute, out var native)) return "ev:" + native;
            if (attribute.StartsWith("on", StringComparison.Ordinal) && attribute.Length > 2) return "hev:" + attribute;
            return null;
        }

        private bool EventAttribute(string name, string value, Shape shape, ScreenHtmlCanon.Element element)
        {
            var dot = name.IndexOf('.');
            if (dot > 0) {
                // The fallback form of arguments: on<event>.<Param>="expression".
                var head = name[..dot];
                if (!(head.StartsWith("on", StringComparison.Ordinal) || head.StartsWith('@') || head.StartsWith("html:", StringComparison.Ordinal))) return false;
                var p = EventPrefix(head, shape);
                if (p == null) return false;
                element.Facts[p + ":a:" + name[(dot + 1)..]] = value;
                return true;
            }
            string? prefix;
            if (name.StartsWith('@')) prefix = "h:" + name[1..];
            else if (name.StartsWith("html:", StringComparison.Ordinal)) prefix = "hev:" + name[5..];
            else if (shape.NativeEvents.TryGetValue(name, out var native)) prefix = "ev:" + native;
            // A bare on<event> that is not a native event of the kind is an HTML event: the reading never writes an extended
            // property starting with "on" bare (it is ext:on...), so this is also the form of a new one (C2).
            else if (name.StartsWith("on", StringComparison.Ordinal) && name.Length > 2) prefix = "hev:" + name;
            else return false;
            // The reading writes Destination(Param = expression, ...) (TryCall); the one call of the text forms (ScreenHtml.ParseCall:
            // the spaces around '=' and after ',' optional, as the fragment and the document read it) is the same call here (the
            // review of round 2, A6: @OnNavigate="ShowChainPage(NewStartIndex=NewStartIndex)" compiled in the fragment and was
            // HTML_EDIT_INVALID in the edit). Arguments by position name no input: refused with the named form.
            if (!ScreenHtml.TryCall(value, out var target, out var arguments)) {
                // A script URL (javascript:go()) is never a call: it stays the problem the edit says once, as a script.
                List<(string? Param, string Value)> parsed = [];
                if (ScreenHtml.ScriptUrl(value) || !ScreenHtml.ParseCall(value, out target, out parsed) || parsed.Any(a => a.Param == null)) {
                    canon.Problems.Add("event " + name + " is not Destination(Param = expression, ...): " + value
                        + (parsed is { Count: > 0 } && parsed.Any(a => a.Param == null) ? " (its arguments go by position; the page names each input: " + target + "(" + string.Join(", ", parsed.Select((a, n) => (a.Param ?? "<input" + (n + 1).ToString(CultureInfo.InvariantCulture) + ">") + " = " + a.Value.Trim())) + "))" : ""));
                    return true;
                }
                arguments = parsed.Select(a => (a.Param!, a.Value.Trim())).ToList();
            }
            element.Facts[prefix] = target.Length == 0 ? "" : m.TryResolveDestination(target, scope, out var resolved) ? resolved : "?" + target;
            foreach (var (param, expression) in arguments) element.Facts[prefix + ":a:" + param] = expression;
            return true;
        }
    }
}

// The attribute tables, shared by the writer and the decoder.
internal static class ScreenHtmlTables
{
    public static readonly Dictionary<string, Dictionary<string, string>> Named = new(StringComparer.Ordinal) {
        ["Input"] = Map("Variable", "bind", "InputType", "type", "Prompt", "placeholder", "MaxLength", "maxlength", "Mandatory", "required", "Enabled", "enabled"),
        ["TextArea"] = Map("Variable", "bind", "Prompt", "placeholder", "MaxLength", "maxlength", "Mandatory", "required", "Enabled", "enabled", "TextLines", "rows"),
        ["Checkbox"] = Map("Variable", "bind", "Mandatory", "required", "Enabled", "enabled"),
        ["Switch"] = Map("Variable", "bind", "Mandatory", "required", "Enabled", "enabled"),
        ["RadioGroup"] = Map("Variable", "bind", "Mandatory", "required", "Enabled", "enabled"),
        ["ButtonGroup"] = Map("Variable", "bind", "Mandatory", "required", "Enabled", "enabled"),
        // No Upload has Enabled (neither Service Studio 11 nor ODC Studio): enabled is no attribute of an <upload>.
        ["Upload"] = Map("FileContent", "content", "FileName", "filename", "Mandatory", "required"),
        ["RadioButton"] = Map("Value", "value", "Enabled", "enabled"),
        ["ButtonGroupItem"] = Map("Value", "value", "Enabled", "enabled"),
        ["Dropdown"] = Map("Variable", "bind", "List", "options", "Values", "value", "Labels", "label", "EmptyValue", "empty", "Mandatory", "required", "Enabled", "enabled"),
        ["Button"] = Map("Enabled", "enabled"),
        ["Link"] = Map("Enabled", "enabled"),
        ["Label"] = Map("TargetWidget", "for"),
        ["Image"] = Map("Image", "src", "Url", "url"),
        ["Icon"] = Map("Icon", "icon", "IconSize", "size", "Weight", "weight"),
        ["List"] = Map("Source", "list"),
        ["TableRecords"] = Map("Source", "list"),
        ["IfWidget"] = Map("Condition", "if"),
        ["Popup"] = Map("ShowPopup", "show"),
        ["MobileBlockInstanceWidget"] = Map("SourceBlock", "name"),
        ["PlaceholderWidget"] = Map("Name", "name", "StyleClasses", "class"),
        ["Expression"] = Map("Value", "value", "Example", "example"),
        ["TextWidget"] = Map("StyleClasses", "class"),
        ["WebBlockInstanceWidget"] = Map("SourceBlock", "name"),
        ["InputWidget"] = Map("Variable", "bind", "MaxLength", "maxlength", "Mandatory", "required", "Enabled", "enabled"),
        ["InputPasswordWidget"] = Map("Variable", "bind", "MaxLength", "maxlength", "Mandatory", "required", "Enabled", "enabled"),
        ["CheckBoxWidget"] = Map("Variable", "bind", "Mandatory", "required", "Enabled", "enabled"),
        ["RadioButtonWidget"] = Map("Variable", "bind", "Value", "value", "Enabled", "enabled"),
        ["ComboBoxWidget"] = Map("Variable", "bind", "SourceRecordList", "options", "Enabled", "enabled"),
        ["ExpressionWidget"] = Map("Value", "value", "Example", "example"),
        ["TableRecordsWidget"] = Map("SourceRecordList", "source", "LineCount", "line-count"),
        ["ListRecordsWidget"] = Map("SourceRecordList", "source", "LineCount", "line-count"),
    };
    public static readonly Dictionary<string, string> CommonNamed = Map("Name", "id", "Style", "class", "CustomStyle", "style");
    public static readonly Dictionary<string, string> DataNamed = Map("Name", "name", "DataType", "type", "DefaultValue", "default",
        "IsMandatory", "mandatory", "Description", "description", "MaxRecords", "max", "Title", "title", "Roles", "roles");

    // The kinds whose name the Studio gives and never lets change: a slot is named after its placeholder, an If branch and a
    // Content by the platform ("Widget does not support name changing" in both lanes, the coverage matrix of fase2). The one rule
    // of the edit: their name is never written, and a text that changes it is HTML_NAME_FIXED.
    public static bool FixedName(string kind) => kind is "PlaceholderContentWidget" or "IfBranchWidget" or "Content";

    static ScreenHtmlTables()
    {
        foreach (var kind in TraditionalOnly) {
            if (!Named.TryGetValue(kind, out var map)) Named[kind] = map = new(StringComparer.Ordinal);
            map["StyleClasses"] = "class";
        }
    }

    private static Dictionary<string, string> Map(params string[] pairs)
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var i = 0; i < pairs.Length; i += 2) map[pairs[i]] = pairs[i + 1];
        return map;
    }

    internal static string TraditionalKind(string kind) => kind switch {
        "Container" => "ContainerWidget", "Link" => "LinkWidget", "Button" => "ButtonWidget",
        "Input" => "InputWidget", "Checkbox" => "CheckBoxWidget", "Dropdown" => "ComboBoxWidget",
        "Expression" => "ExpressionWidget", "MobileBlockInstanceWidget" => "WebBlockInstanceWidget",
        "Image" => "ImageWidget", "Upload" => "InputFilenameWidget", _ => kind
    };
    internal static readonly HashSet<string> TraditionalOnly = new(StringComparer.Ordinal) {
        "WebBlockInstanceWidget", "ContainerWidget", "LinkWidget", "ButtonWidget", "ExpressionWidget", "InputWidget",
        "InputPasswordWidget", "CheckBoxWidget", "RadioButtonWidget", "ComboBoxWidget", "ImageWidget", "ListRecordsWidget", "TableRecordsWidget",
        "TableWidget", "RowWidget", "CellWidget", "UploadWidget", "InputFilenameWidget", "EditRecordWidget", "ShowRecordWidget"
    };

    // The attribute of a property: named for the kind, then for every widget (data elements: their own names), else os-.
    // The class of an element is StyleClasses when the kind names it, else Style; the other one stays os-Style. An HTML
    // Element has no class of its own (its class is an extended property).
    public static string AttributeOf(string kind, string property, ScreenHtmlModuleMode mode, bool hasStyleClasses)
    {
        if (mode == ScreenHtmlModuleMode.Data) return DataNamed.TryGetValue(property, out var d) ? d : "os-" + property;
        if (Named.TryGetValue(kind, out var map) && map.TryGetValue(property, out var a)) return a;
        if (property == "Style" && (kind == "AdvancedHtml" || hasStyleClasses && map != null && map.ContainsValue("class"))) return "os-Style";
        if (property == "CustomStyle" && kind == "AdvancedHtml") return "os-CustomStyle";
        return CommonNamed.TryGetValue(property, out var c) ? c : "os-" + property;
    }

    // attribute -> property for a kind.
    private static readonly Dictionary<(string, ScreenHtmlModuleMode), Dictionary<string, string>> reverse = [];
    public static Dictionary<string, string> Reverse(string kind, ScreenHtmlModuleMode mode)
    {
        lock (reverse) {
            if (reverse.TryGetValue((kind, mode), out var map)) return map;
            map = new Dictionary<string, string>(StringComparer.Ordinal);
            if (mode == ScreenHtmlModuleMode.Data) foreach (var (p, a) in DataNamed) map[a] = p;
            else {
                foreach (var (p, a) in CommonNamed) map[a] = p;
                if (kind == "AdvancedHtml") { map.Remove("class"); map.Remove("style"); }
                if (Named.TryGetValue(kind, out var named)) foreach (var (p, a) in named) map[a] = p;
                // Upload binds its binary content; unlike input widgets it has no Variable property.
                if (kind == "Upload") map["bind"] = "FileContent";
            }
            return reverse[(kind, mode)] = map;
        }
    }

    // The kind of a widget element (the decoder and the writer read tags the same way).
    internal static string KindOf(ScreenHtml.Node node, out string tagText)
    {
        tagText = node.Tag;
        if (node.NativeKind is { } cell) return cell;
        if (node.Tag == "table" && NativeTable(node) is { } table) { Mark(table); return "TableRecords"; }
        if (node.Get("list") != null) { if (node.Tag == "list") tagText = node.Get("tag") ?? ""; return "List"; }
        if (node.Tag == "div" && node.Get("if") != null) return "IfWidget";
        if (node.Get("html") != null) return "AdvancedHtml";
        if (node.Tag == "html-element") { tagText = node.Get("tag") ?? ""; return "AdvancedHtml"; }
        if (node.Tag == "input") return node.Get("type") == "checkbox" ? "Checkbox" : "Input";
        // The rows of the language with no HTML tag of their own (switch, upload, button-group, button-group-item, i) are the
        // rows of ElementWidgetMap.LanguageElements too (this file is also compiled by the ODC builder, without that table: a
        // test holds the two equal).
        foreach (var (kd, tag) in ScreenHtml.WidgetTags) if (tag == node.Tag && kd is not ("Checkbox" or "IfWidget" or "Input") && !ScreenHtml.ShapeKinds.Contains(kd) && !TraditionalOnly.Contains(kd)) return kd;
        return "AdvancedHtml";
    }

    // ---- the data table (the owner's VpBookings bug of 2026-10-18) --------------------------------------------------------
    // A data table is the native Table (TableRecords): a <table> whose only parts are one <thead> with one <tr> of <th> (the header
    // row) and one <tbody> with one template <tr> of <td> (the row), its rows repeated over a list written once, on the <table>
    // (the reading's form), on the <tbody> or on the template <tr> (the forms documents write). One column per <th>/<td> pair: a
    // header cell and a row cell in the same column of the widget, aligned by construction. Its parts carry no k (an HTML table of
    // a reading has one on each: it stays what it is). Anything else (no header row, no list, a caption, a footer, two rows) is
    // what it was: HTML Elements, a List where the list is.
    internal sealed record NativeTableShape(ScreenHtml.Node Table, ScreenHtml.Node Head, ScreenHtml.Node HeadRow, ScreenHtml.Node Body, ScreenHtml.Node BodyRow,
        IReadOnlyList<ScreenHtml.Node> HeaderCells, IReadOnlyList<ScreenHtml.Node> RowCells, string Source, ScreenHtml.Node SourceAt);

    // The attributes of a List a data table's rows may carry where its list is (the List's own means to render every row; a native
    // Table renders them all): never written, said in normalized.
    internal static readonly HashSet<string> ListOnlyAttributes = new(StringComparer.Ordinal) { "os-Mode", "disable-virtualization", "ext:disable-virtualization" };

    internal static NativeTableShape? NativeTable(ScreenHtml.Node table)
    {
        // <table html> is the HTML Element the author asked for, whatever its parts.
        if (table.IsText || table.Tag != "table" || table.Get("html") != null) return null;
        if (Parts(table) is not [{ Tag: "thead" } head, { Tag: "tbody" } body]) return null;
        if (Parts(head) is not [{ Tag: "tr" } headRow] || Parts(body) is not [{ Tag: "tr" } bodyRow]) return null;
        if (Parts(headRow) is not { } header || Parts(bodyRow) is not { } row) return null;
        if (header.Any(c => c.Tag != "th") || row.Any(c => c.Tag != "td")) return null;
        if (head.Get("k") != null || headRow.Get("k") != null || body.Get("k") != null || bodyRow.Get("k") != null) return null;
        var holders = new[] { table, body, bodyRow }.Where(n => n.Get("list") != null).ToList();
        if (holders.Count != 1) return null;
        return new NativeTableShape(table, head, headRow, body, bodyRow, header, row, holders[0].Get("list")!, holders[0]);
    }

    // The message of half a column (the decoder's; the edit says it with the Table's k and its patch, HTML_TABLE_COLUMN).
    internal static string HalfColumn(NativeTableShape table) =>
        "the native Table at line " + table.Table.Line.ToString(System.Globalization.CultureInfo.InvariantCulture) + " has " + table.HeaderCells.Count + " header cells and "
        + table.RowCells.Count + " row cells: a column is one <th> and one <td> (remove or add both)";
    internal static bool IsHalfColumn(string problem) =>
        problem.StartsWith("the native Table at line ", StringComparison.Ordinal) && problem.EndsWith(" row cells: a column is one <th> and one <td> (remove or add both)", StringComparison.Ordinal);

    // The classes the Studio gives a List (list, list-group: an older reading writes them on the <tbody> or <tr> that was the List).
    private static readonly HashSet<string> ListClasses = new(StringComparer.Ordinal) { "list", "list-group" };

    // The class of the header row (header) or of the template row: the class of its section (<thead>, <tbody>: a Table has no
    // class of its own for them) and of its <tr>, in that order; where the list is, the classes of the List an older reading wrote
    // (list, list-group) are left out (dropped receives them). Null: no class.
    internal static string? RowClass(NativeTableShape table, bool header, List<string>? dropped = null)
    {
        var parts = new List<string>();
        var written = false;   // a class written, empty included (class="" is the empty class the reading writes)
        foreach (var part in header ? new[] { table.Head, table.HeadRow } : [table.Body, table.BodyRow]) {
            if (part.Get("class") is not { } value) continue;
            var listClass = false;
            if (ReferenceEquals(part, table.SourceAt) && !value.Contains("{{", StringComparison.Ordinal)) {
                var tokens = value.Split(' ', StringSplitOptions.RemoveEmptyEntries).ToList();
                var left = tokens.Where(ListClasses.Contains).ToList();
                if (left.Count > 0) { dropped?.AddRange(left.Select(c => "class " + c)); value = string.Join(" ", tokens.Where(x => !ListClasses.Contains(x))); listClass = true; }
            }
            // The row's own class, empty included; a class that held only the List's is no class of the row.
            written |= part.Tag == "tr" && !(listClass && value.Length == 0);
            if (value.Trim().Length > 0) parts.Add(value.Trim());
        }
        return parts.Count > 0 ? string.Join(" ", parts) : written ? "" : null;
    }

    // What a part of a native Table may say: the list where it is, beside it the List's own attributes (os-Mode,
    // disable-virtualization: a Table renders every row), and its class (the row's); a marker of the engine has its own rule
    // (ReservedMarker). Anything else has no property in the Table.
    internal static IEnumerable<(ScreenHtml.Node Part, string Attribute)> PartAttributes(NativeTableShape table, bool header)
    {
        foreach (var part in header ? new[] { table.Head, table.HeadRow } : [table.Body, table.BodyRow])
            foreach (var (attribute, _) in part.Attributes) {
                if (attribute == "class" || IsEngineMarker(attribute)) continue;
                if (ReferenceEquals(part, table.SourceAt) && (attribute == "list" || ListOnlyAttributes.Contains(attribute))) continue;
                yield return (part, attribute);
            }
    }
    internal const string PartAttributeWhy = "a native Table has no property for an attribute of its <thead>, <tbody> or <tr> but the class (the row's); put it on the <table> or on a cell";
    // A problem of the decoder that the table rules of the document and of the edit say with their own code and patch (half a column,
    // an attribute of a part).
    internal static bool IsTableProblem(string problem) => IsHalfColumn(problem) || problem.EndsWith(": " + PartAttributeWhy, StringComparison.Ordinal);

    // The markers of the engine's native layout block (Anvil.Core.ScreenVisual.MarkerOf: data-ssam-gap, data-ssam-page, data-ssam-rows,
    // in any case, ext: or not), left to their own rule (HTML_RESERVED_MARKER). This file is also compiled by the ODC builder, without
    // ScreenVisual (Builder.csproj): a test holds the two equal.
    private static readonly string[] EngineMarkers = ["data-ssam-gap", "data-ssam-page", "data-ssam-rows"];
    internal static bool IsEngineMarker(string attribute)
    {
        var bare = attribute.StartsWith("ext:", StringComparison.OrdinalIgnoreCase) ? attribute[4..] : attribute;
        return EngineMarkers.Any(m => m.Equals(bare, StringComparison.OrdinalIgnoreCase));
    }

    // The columns a cell spans (colspan), 1 when it says none.
    internal static int Span(ScreenHtml.Node cell) =>
        int.TryParse(cell.Get("colspan"), NumberStyles.None, CultureInfo.InvariantCulture, out var n) && n > 1 ? n : 1;

    // Half a column that colspan explains: the row with fewer cells spans, cell by cell, the cells of the other, which span none.
    // True only then (the rows hold a different number of cells); which cell is missing otherwise is the author's.
    internal static bool SpanExplains(NativeTableShape table) => SpanExplains(table.HeaderCells, table.RowCells);
    // The same rule over the cells of the two rows (the prototype importer's data table, PrototypeWidgets.DataTable).
    internal static bool SpanExplains(IReadOnlyList<ScreenHtml.Node> headerCells, IReadOnlyList<ScreenHtml.Node> rowCells)
    {
        if (headerCells.Count == rowCells.Count) return false;
        var (fewer, more) = headerCells.Count < rowCells.Count ? (headerCells, rowCells) : (rowCells, headerCells);
        return fewer.Sum(Span) == more.Count && more.All(c => Span(c) == 1);
    }

    // A cell of a native Table spans one column and one row (the owner's decision of 2026-10-19): with the rows as many cells, colspan
    // made the header wider than the rows, and rowspan on the template row (it repeats once per record) pushed the cells of the next
    // record's row, both in silence. Its colspan and rowspan (any case, ext: or not) with a value other than 1, refused where the
    // document (ScreenDocument.TableProblems) and the edit (EditPlan.TableRules) write them new, each with its certain patch: the
    // columns a colspan explains written as empty cells (SpanExplains), else the attribute removed. What the reading has stays.
    internal static IEnumerable<(string Attribute, string Value)> Spans(ScreenHtml.Node cell)
    {
        foreach (var (attribute, value) in cell.Attributes)
            if (SpanOf(attribute) != null && value.Trim() != "1") yield return (attribute, value);
    }
    // colspan or rowspan, for the attribute that is one (any case, ext: or not); else null.
    private static string? SpanOf(string attribute)
    {
        var bare = attribute.StartsWith("ext:", StringComparison.OrdinalIgnoreCase) ? attribute[4..] : attribute;
        return bare.Equals("colspan", StringComparison.OrdinalIgnoreCase) ? "colspan" : bare.Equals("rowspan", StringComparison.OrdinalIgnoreCase) ? "rowspan" : null;
    }
    // The colspan whose columns the patch of half a column writes as empty cells (SpanExplains), not removed.
    internal static bool SpanExplained(NativeTableShape table, ScreenHtml.Node cell, string attribute) => attribute == "colspan" && Span(cell) > 1 && SpanExplains(table);
    internal const string ColumnSpanWhy = "a native Table has one <th> and one <td> per column, and a cell spans none";
    internal static string SpanWhy(string attribute, string tag) => SpanOf(attribute) != "rowspan" ? ColumnSpanWhy
        : tag == "td" ? "a cell of a native Table spans one row: its template row repeats once per record, and rowspan pushes the cells of the next record's row"
        : "a cell of a native Table spans one row: its header row is one row";

    // What a native Table makes of what its parts write beyond its properties, said in normalized by the document and by the edit
    // (TABLE_NATIVE): the class of a section joins the class of its row; the List's own classes and attributes where the list is are
    // left out (a Table renders every row).
    internal static List<string> Folded(NativeTableShape table)
    {
        var notes = new List<string>();
        var dropped = new List<string>();
        foreach (var (header, section, row, style) in new[] { (true, table.Head, table.HeadRow, "StyleHeader"), (false, table.Body, table.BodyRow, "StyleRow") })
            if (RowClass(table, header, dropped) != row.Get("class") && section.Get("class") != null) notes.Add($"<{section.Tag} class> joins the class of its <tr> ({style})");
        foreach (var part in new[] { table.Body, table.BodyRow }.Where(p => ReferenceEquals(p, table.SourceAt)))
            foreach (var (attribute, _) in part.Attributes) if (ListOnlyAttributes.Contains(attribute)) dropped.Add(attribute);
        if (dropped.Count > 0) notes.Add($"{string.Join(", ", dropped.Distinct())} of the List left out (a Table renders every row)");
        return notes;
    }

    // The element children of a part, or null when it holds text (whitespace between elements is the layout of the text).
    private static List<ScreenHtml.Node>? Parts(ScreenHtml.Node node)
    {
        var parts = new List<ScreenHtml.Node>();
        foreach (var child in node.Children)
            if (child.IsText) { if (child.Text!.Trim().Length > 0) return null; }
            else parts.Add(child);
        return parts;
    }

    private static void Mark(NativeTableShape table)
    {
        foreach (var th in table.HeaderCells) th.NativeKind = "HeaderCell";
        foreach (var td in table.RowCells) td.NativeKind = "RowCell";
    }

    // Every data table of a parsed text, its cells marked (a visitor of the cells alone reads their kind right).
    internal static void MarkNativeTables(ScreenHtml.Node node)
    {
        foreach (var child in node.Children)
        {
            if (child.IsText) continue;
            if (child.Tag == "table" && NativeTable(child) is { } table) Mark(table);
            MarkNativeTables(child);
        }
    }

    // Names an extended property cannot take bare on this kind (the element spends them on itself).
    public static bool Reserved(string kind, string attribute) =>
        attribute is "k" or "html" or "tag" or "list" or "if" or "else" or "id" or "name" or "value" or "type"
        || attribute.StartsWith("on", StringComparison.Ordinal) || attribute.StartsWith("os-", StringComparison.Ordinal)
        || attribute.StartsWith("ext:", StringComparison.Ordinal) || attribute.StartsWith("html:", StringComparison.Ordinal)
        || attribute.StartsWith(':') || attribute.StartsWith('@')
        || Reverse(kind, ScreenHtmlModuleMode.Widget).ContainsKey(attribute);

    private static readonly Dictionary<string, string> InputTypes = new(StringComparer.Ordinal) {
        ["Text"] = "text", ["Password"] = "password", ["Number"] = "number", ["Date"] = "date", ["Time"] = "time", ["DateTime"] = "datetime-local",
        ["Phone"] = "tel", ["Email"] = "email", ["Search"] = "search" };
    public static string InputTypeOut(string value) => InputTypes.TryGetValue(value, out var html) ? html : value;
    public static string InputTypeIn(string value) => InputTypes.FirstOrDefault(p => p.Value == value).Key ?? value;
}

internal enum ScreenHtmlModuleMode { Widget = 0, Data = 1 }
