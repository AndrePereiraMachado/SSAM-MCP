using System.Collections;

namespace Anvil.Reading;

// Shared by both kernels and the ODC builder. No dependency on either Studio's assemblies.
public sealed record ReadingOptions(int Depth = 3, int Max = 60, int Offset = 0,
    string? Kind = null, string? Name = null, string? Text = null, string? Properties = null,
    bool Full = false, bool All = false, bool Usages = false, string Scope = "subtree", bool IncludeInternal = false)
{
    public bool IsQuery => Kind != null || Name != null || Text != null || Offset != 0;
    public void Validate()
    {
        if (Depth is < 0 or > 12) throw new ArgumentException("--depth must be between 0 and 12");
        if (Max is < 1 or > 500) throw new ArgumentException("--max must be between 1 and 500");
        if (Offset < 0) throw new ArgumentException("--offset must be non-negative");
        if (Scope is not ("direct" or "subtree")) throw new ArgumentException("--scope must be direct or subtree");
        if (Usages && (Kind != null || Name != null || Text != null || Properties != null))
            throw new ArgumentException("--usages selects incoming references; select its target by path or @key, without property/search filters");
        if (!Usages && (Scope != "subtree" || IncludeInternal)) throw new ArgumentException("--scope and --include-internal require --usages");
    }
    public static ReadingOptions Parse(string[] args)
    {
        string? Value(string flag) {
            var index = Array.IndexOf(args, flag);
            if (index < 0) return null;
            if (index + 1 == args.Length || args[index + 1].StartsWith("--")) throw new ArgumentException("Missing value for " + flag);
            return args[index + 1];
        }
        int Number(string flag, int fallback) => Value(flag) is not { } value ? fallback
            : int.TryParse(value, out var number) ? number : throw new ArgumentException("Invalid integer for " + flag);
        var result = new ReadingOptions(Number("--depth", 3), Number("--max", 60), Number("--offset", 0),
            Value("--kind"), Value("--name"), Value("--text"), Value("--properties"), args.Contains("--full"), args.Contains("--all"),
            args.Contains("--usages"), Value("--scope") ?? "subtree", args.Contains("--include-internal"));
        result.Validate();
        return result;
    }
    public static bool Requested(string[] args) => args.Any(a => a is "--path" or "--kind" or "--name" or "--text"
        or "--properties" or "--depth" or "--max" or "--offset" or "--full" or "--all" or "--usages" or "--scope" or "--include-internal");
}

public abstract class ModelReader<T> where T : class
{
    protected abstract IEnumerable<T> Children(T node);
    protected abstract T? Parent(T node);
    protected abstract string Key(T node);
    protected abstract string Kind(T node);
    protected abstract string Name(T node);
    protected abstract string? Label(T node);
    // Every name a node answers to as a kind (interface Name and FullName, plus adapter extras). One set per node type:
    // HasKind is membership of the kind or its I-prefixed form, so the module index matches exactly what Read matches.
    protected abstract IReadOnlySet<string> KindNames(T node);
    protected abstract IEnumerable<(string Name, Func<object?> Read)> Properties(T node);
    protected abstract string? Expression(object value);
    protected abstract IEnumerable<T> Referrers(T node);
    private static readonly HashSet<string> Noise = new(StringComparer.Ordinal) {
        "CreatedBy", "CreatedByAgent", "CreatedByTool", "LastModifiedBy", "LastModifiedByAgent", "LastModifiedByTool",
        "LastModifiedDate", "LastMergedBy", "LastMergedDate", "ModifiedByAgents", "ModifiedByTools", "FullSignatureHash",
        "CompatibilitySignatureHash", "Digest", "ContentDigest", "UniqueId", "Parent", "Children", "Metadata", "TextResources", "TextResourcesIds"
    };
    public IEnumerable<T> Walk(T root)
    {
        var pending = new Stack<T>(); pending.Push(root);
        var visited = new HashSet<T>(ReferenceEqualityComparer.Instance);
        while (pending.TryPop(out var node)) {
            if (!visited.Add(node)) continue;
            yield return node;
            foreach (var child in Children(node).Reverse()) pending.Push(child);
        }
    }
    internal const string KindNotObserved = "No instance of the requested kind was observed in this scope. Check the kind spelling and scope; this does not prove that the type is unsupported.";
    private bool HasKind(T node, string kind) { var names = KindNames(node); return names.Contains(kind) || names.Contains("I" + kind); }
    private string Display(T node) => string.IsNullOrEmpty(Name(node)) ? Label(node) ?? "" : Name(node);
    // ModuleIndex reads each node through these, with the same rules as Read (Display, kind names, parent, children).
    internal (string Key, string Kind, string Name, string ModelName, string? Label, IReadOnlySet<string> Kinds, T? Parent, int Children) Describe(T node)
    {
        var modelName = Name(node); var label = Label(node);
        return (Key(node), Kind(node), string.IsNullOrEmpty(modelName) ? label ?? "" : modelName, modelName, label, KindNames(node), Parent(node), Children(node).Count());
    }
    // Tree with --properties Name: true when the Name property projects exactly to Name(node), false when the node has
    // no Name property (propertiesMissing), null when only the model can reproduce the answer.
    internal bool? NameProjection(T node, string modelName)
    {
        object? value;
        try { if (FindProperty(node, "Name") is not { } read) return false; value = read(); } catch { return null; }
        // Only plain text is reproducible from Name(node); an expression or a reference needs the model.
        if (value != null && (Expression(value) != null || value is not string)) return null;
        return ((string?)value ?? "") == modelName ? true : null;
    }
    // A property as Tree prints it, for values that are text, expressions or model references (DataType).
    internal string? PropertyText(T node, string property)
    {
        if (FindProperty(node, property) is not { } read) return null;
        var value = read();
        return value == null ? null : Expression(value) ?? (value is T reference ? Kind(reference) + ":" + Display(reference) : value.ToString());
    }
    // The property Properties(node) lists under this name, or null; a name listed twice throws (Tree would show both).
    // Adapters with a per-type property table override it: the index reads Name through it for every element.
    protected virtual Func<object?>? FindProperty(T node, string name)
    {
        Func<object?>? found = null;
        foreach (var prop in Properties(node))
            if (prop.Name == name) found = found == null ? prop.Read : throw new InvalidOperationException("Property listed twice: " + name);
        return found;
    }
    private string PathOf(T node) {
        var parts = new List<string>(); var seen = new HashSet<T>(ReferenceEqualityComparer.Instance);
        for (var at = node; at != null && Parent(at) != null && seen.Add(at); at = Parent(at))
            parts.Add(Kind(at) + ":" + Clip(Display(at), 80));
        parts.Reverse(); return string.Join("/", parts);
    }
    private object Identity(T node) => new { kind = Kind(node), name = Name(node), label = Label(node), key = Key(node), reference = "@" + Key(node), path = PathOf(node) };
    // The same rules as a job's references (Verbs.Resolve, C21): @espace is the module; a segment answers to the Name, or
    // the Label of an element without a name, among the children and then among the descendants; True/False under an If
    // follow its branches.
    public T Resolve(T root, string path)
    {
        if (path is "" or "/" or "@espace") return root;
        if (path.StartsWith("@espace/", StringComparison.Ordinal)) path = path["@espace".Length..];
        // Native keys can contain '/' (base64). A key is opaque, never a segmented path.
        if (path.StartsWith('@')) {
            var keyed = Walk(root).Where(n => Key(n) == path[1..]).ToArray();
            return keyed.Length == 1 ? keyed[0] : throw new InvalidOperationException("Unresolved or ambiguous key in this snapshot: " + path);
        }
        var current = root;
        foreach (var segment in path.Split('/', StringSplitOptions.RemoveEmptyEntries)) {
            var parts = segment.Split(':', 2);
            bool Matches(T node) => segment.StartsWith('@') ? Key(node) == segment[1..]
                : (parts.Length == 1 || parts[0] == "*" || HasKind(node, parts[0]))
                    && (parts[^1] == "*" || string.Equals(Display(node), parts[^1], StringComparison.OrdinalIgnoreCase));
            var hits = (segment.StartsWith('@') ? Walk(current) : Children(current)).Where(Matches).ToArray();
            if (hits.Length == 0 && Branch(current, segment) is { } branch) { current = branch; continue; }
            if (hits.Length == 0) hits = Walk(current).Skip(1).Where(Matches).ToArray();
            if (hits.Length != 1) {
                var examples = (hits.Length > 0 ? hits : Children(current).ToArray()).Take(8)
                    .Select(n => Kind(n) + ":" + Clip(Display(n), 80) + " @" + Key(n));
                throw new InvalidOperationException((hits.Length > 1 ? "Ambiguous" : "Unresolved") + " model path '" + segment
                    + "' under " + Kind(current) + ":" + Clip(Display(current), 80) + ". " + string.Join("; ", examples)
                    + (hits.Length > 1 ? ". Use @key from this same snapshot." : ""));
            }
            current = hits[0];
        }
        return current;
    }
    // True/False of an If (TrueTarget/FalseTarget), the names its connectors show in the Studio.
    private T? Branch(T node, string segment)
    {
        var property = segment.Equals("True", StringComparison.OrdinalIgnoreCase) ? "TrueTarget"
            : segment.Equals("False", StringComparison.OrdinalIgnoreCase) ? "FalseTarget" : null;
        if (property == null) return null;
        try { return FindProperty(node, property)?.Invoke() as T; } catch { return null; }
    }
    public object Read(T root, string path, ReadingOptions options)
    {
        options.Validate();
        var node = Resolve(root, path);
        if (options.Usages) return ReadUsages(node, path, options);
        if (!options.IsQuery) return new { schema = "ssam-reading/1", path, tree = Tree(node, options, options.Depth) };
        var entries = new List<object>(); var count = 0; var readErrors = 0; var errorSamples = new List<object>();
        var kindObserved = false;
        void ReadError(T candidate, string property, Exception error) {
            readErrors++;
            if (errorSamples.Count < 8) errorSamples.Add(new { reference = "@" + Key(candidate), property, error = Clip(error.GetBaseException().Message, 200) });
        }
        // Native child enumeration can differ across loads; pagination must not repeat/skip objects.
        foreach (var candidate in Walk(node).OrderBy(Key, StringComparer.Ordinal)) {
            if (options.Kind != null && options.Kind != "*" && !HasKind(candidate, options.Kind)) continue;
            kindObserved = true;
            if (options.Name != null && !string.Equals(Display(candidate), options.Name, StringComparison.OrdinalIgnoreCase)) continue;
            if (options.Text != null && !SearchText(candidate, (p, e) => ReadError(candidate, p, e)).Any(s => s.Contains(options.Text, StringComparison.OrdinalIgnoreCase))) continue;
            if (count++ < options.Offset || entries.Count >= options.Max) continue;
            entries.Add(Tree(candidate, options, 0));
        }
        var end = options.Offset + entries.Count;
        return new { schema = "ssam-reading/1", path, count, returned = entries.Count, offset = options.Offset,
            omitted = count - entries.Count, truncated = count != entries.Count, nextOffset = end < count ? (int?)end : null,
            kindObserved, notices = kindObserved ? Array.Empty<string>() : new[] { KindNotObserved },
            searchComplete = readErrors == 0, propertyReadErrors = readErrors, errorSamples, entries };
    }
    private object ReadUsages(T node, string path, ReadingOptions options)
    {
        // An edge is consumer -> actual referenced object, not just a consumer name.
        // Entity identifiers, parameters, attributes and events can receive references independently.
        var descendants = new HashSet<T>(Walk(node), ReferenceEqualityComparer.Instance);
        var targets = options.Scope == "direct" ? new[] { node } : (IEnumerable<T>)descendants;
        var edges = new List<(T Consumer, T Target, bool Internal)>();
        var errors = new List<object>(); var excludedInternal = 0; var examined = 0;
        foreach (var target in targets) {
            examined++;
            var seen = new HashSet<T>(ReferenceEqualityComparer.Instance);
            try {
                foreach (var consumer in Referrers(target)) {
                    if (consumer == null || !seen.Add(consumer)) continue;
                    var inside = descendants.Contains(consumer);
                    if (inside && !options.IncludeInternal) { excludedInternal++; continue; }
                    edges.Add((consumer, target, inside));
                }
            } catch (Exception error) {
                errors.Add(new { target = Identity(target), error = Clip(error.GetBaseException().Message, 200) });
            }
        }
        var page = edges.OrderBy(e => Key(e.Target), StringComparer.Ordinal).ThenBy(e => Key(e.Consumer), StringComparer.Ordinal)
            .Skip(options.Offset).Take(options.Max).Select(e => new {
                consumer = Identity(e.Consumer), target = Identity(e.Target),
                relation = ReferenceEquals(e.Target, node) ? "direct" : "descendant", internalUse = e.Internal
            }).ToArray();
        var end = options.Offset + page.Length;
        return new { schema = "ssam-usages/1", path, target = Identity(node), scope = options.Scope,
            includeInternal = options.IncludeInternal, complete = errors.Count == 0, targetsExamined = examined,
            count = edges.Count, consumers = edges.Select(e => e.Consumer).Distinct(ReferenceEqualityComparer.Instance).Count(),
            direct = edges.Count(e => ReferenceEquals(e.Target, node)), descendant = edges.Count(e => !ReferenceEquals(e.Target, node)),
            internalUses = edges.Count(e => e.Internal), excludedInternal,
            byTargetKind = edges.GroupBy(e => Kind(e.Target)).ToDictionary(g => g.Key, g => g.Count()),
            byConsumerKind = edges.GroupBy(e => Kind(e.Consumer)).ToDictionary(g => g.Key, g => g.Count()),
            returned = page.Length, offset = options.Offset, omitted = edges.Count - page.Length,
            truncated = edges.Count != page.Length, nextOffset = end < edges.Count ? (int?)end : null,
            referenceReadErrors = errors.Count, errorSamples = errors.Take(8).ToArray(), entries = page,
            limitations = new[] { "Native model references only; literal strings, URLs, runtime lookups and external consumers are not inferred.",
                "Descendant references identify exact targets; replacing the parent does not imply replacing its children. No derived references are filtered." }
        };
    }
    private IEnumerable<string> SearchText(T node, Action<string, Exception> onError)
    {
        yield return Display(node);
        foreach (var prop in Properties(node)) {
            if (Noise.Contains(prop.Name)) continue;
            string? text;
            try { var value = prop.Read(); text = value is string str ? str : value != null ? Expression(value) : null; }
            catch (Exception error) { onError(prop.Name, error); continue; }
            if (text != null) yield return text;
        }
    }
    private object Tree(T node, ReadingOptions options, int depth)
    {
        var values = new Dictionary<string, string>();
        var references = new Dictionary<string, object>();
        var omissions = new Dictionary<string, object>();
        var errors = new Dictionary<string, string>();
        var projection = options.Properties?.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries).ToHashSet(StringComparer.Ordinal);
        var available = Properties(node).ToArray();
        foreach (var prop in available) {
            if (projection != null && !projection.Contains(prop.Name) || !options.All && Noise.Contains(prop.Name)) continue;
            try {
                var value = prop.Read(); string? text;
                if (value == null) continue;
                if (Expression(value) is { } expression) text = expression;
                else if (value is T reference) { text = Kind(reference) + ":" + Display(reference); references[prop.Name] = Identity(reference); }
                else if (value is byte[] binary) text = binary.Length + " bytes";
                else if (value is string str) text = str;
                else if (value is IEnumerable items) {
                    var parts = new List<string>(); var count = 0;
                    foreach (var item in items) { count++; if (options.Full || parts.Count < 20) parts.Add(item is T child ? Kind(child) + ":" + Display(child) : item?.ToString() ?? "null"); }
                    if (count > parts.Count) omissions[prop.Name] = new { reason = "items", total = count, shown = parts.Count };
                    text = "[" + string.Join(", ", parts) + (count > parts.Count ? ", …" : "") + "]";
                } else text = value.ToString();
                if (string.IsNullOrEmpty(text)) continue;
                if (!options.Full && text.Length > 400) {
                    // Preserve both limits when a collection is also clipped as text. The continuation reads exactly that
                    // property of that element in full (C19).
                    omissions[prop.Name + ":text"] = new { reason = "characters", total = text.Length, shown = 400,
                        continuation = new { path = "@" + Key(node), properties = prop.Name, full = true } };
                    text = Clip(text, 400);
                }
                values[prop.Name] = text;
            } catch (Exception error) { errors[prop.Name] = error.GetBaseException().Message; }
        }
        var children = Children(node).ToArray();
        var shown = depth > 0 ? children.Take(options.Max).Select(c => Tree(c, options, depth - 1)).ToArray() : Array.Empty<object>();
        return new { kind = Kind(node), name = Display(node), modelName = Name(node), label = Label(node), key = Key(node), reference = "@" + Key(node), path = PathOf(node),
            properties = values, propertyReferences = references, propertiesOmitted = omissions, propertyErrors = errors,
            propertiesMissing = projection?.Except(available.Select(p => p.Name)).ToArray() ?? Array.Empty<string>(),
            children = shown, childrenTotal = children.Length, childrenOmitted = children.Length - shown.Length };
    }
    private static string Clip(string text, int max) => text.Length > max ? text[..max] + "…" : text;
}
