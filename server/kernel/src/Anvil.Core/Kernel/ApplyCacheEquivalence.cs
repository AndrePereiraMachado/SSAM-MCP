using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;
using OutSystems.Model;
using ServiceStudio.Model;

namespace Anvil.Core;

/// <summary>
/// S12 (apply indexes): what a candidate says, apart from the keys its apply drew, so two applies of one job (the caches on
/// and off, ApplyCacheTests) compare element by element. Every value MergeContentProof reads (kind, owner, properties, the
/// owner's connector targets, references), and the module read back as text (the data text and every action's flow text). A
/// key the base does not have, and a record named by a hash of its content, is written as the name of what it is (Names); a
/// base key stays itself.
/// </summary>
internal static class ApplyCacheEquivalence
{
    // A local key (MergeContentProof's LocalKey: 22 characters of base64 with + _ -) inside an identity or a value.
    private static readonly Regex LocalKey = new(@"(?<![A-Za-z0-9+_\-])[A-Za-z0-9+_\-]{22}(?![A-Za-z0-9+_\-])", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    // A key the module's text writes after @ (the data text's "-- @key" of an element).
    private static readonly Regex TextKey = new(@"@([A-Za-z0-9+_\-]{22})(?![A-Za-z0-9+_\-])", RegexOptions.Compiled | RegexOptions.CultureInvariant);

    // Coarse: every value with each new element by its label alone (sorted lines): where two readings differ, the lines that
    // do, before the names of what holds them change too.
    internal sealed record Reading(SortedDictionary<string, string> Values, string Text, int NewElements, Func<string, string> CoarseName, List<string> Coarse)
    {
        /// <summary>A JSON answer of the apply (the Verify's messages) with every new element in it by its label (as Coarse) and
        /// every list sorted: a message names one of several alike elements, and lists them in the walk's order.</summary>
        internal string Messages(JsonNode? node) => node switch {
            null => "null",
            JsonObject o => "{" + string.Join(",", o.Select(p => CoarseName(p.Key) + ":" + Messages(p.Value))) + "}",
            JsonArray a => "[" + string.Join(",", a.Select(Messages).Order(StringComparer.Ordinal)) + "]",
            // The Verify's paths may carry a key JSON-escaped inside the text (+ written as its escape).
            JsonValue v when v.TryGetValue<string>(out var s) => "\"" + CoarseName(s.Replace("\\u002B", "+").Replace("\\u002F", "/")) + "\"",
            _ => node.ToJsonString(),
        };
    }

    // Every occurrence of a new key in a text (an identity, a value, a flow text), written as its token: keys are found by
    // their exact text, at every place and for every length a new key has.
    private static Func<string, string> Replacer(Dictionary<string, string> tokens)
    {
        var lengths = tokens.Keys.Select(k => k.Length).Distinct().OrderByDescending(l => l).ToArray();
        return text => {
            StringBuilder? result = null;
            var last = 0;
            for (var i = 0; i < text.Length; i++)
                foreach (var length in lengths) {
                    if (i + length > text.Length || !tokens.TryGetValue(text.Substring(i, length), out var token)) continue;
                    (result ??= new StringBuilder()).Append(text, last, i - last).Append(token);
                    last = i + length; i = last - 1;
                    break;
                }
            return result == null ? text : result.Append(text, last, text.Length - last).ToString();
        };
    }

    internal static Reading Read(ModelHost host, string candidatePath, string basePath)
    {
        ESpace? @base = null, candidate = null;
        try {
            var reader = new KernelModelReader();
            @base = host.Load(File.ReadAllBytes(basePath));
            var known = reader.Walk((IObjectSignature)@base).Select(o => o.ObjectKey?.ToString()).OfType<string>().ToHashSet(StringComparer.Ordinal);
            foreach (var ((key, _), value) in Unescaped(MergeContentProof.Read(@base)))
                foreach (var part in new[] { key, value }) foreach (Match m in LocalKey.Matches(part)) known.Add(m.Value);
            ModelHost.Release(@base); @base = null;
            candidate = host.Load(File.ReadAllBytes(candidatePath));
            var labels = new Dictionary<string, string>(StringComparer.Ordinal);
            var values = Unescaped(MergeContentProof.Read(candidate, null, labels));
            var (tokens, coarse) = Names(values, labels, known, reader.Walk((IObjectSignature)candidate)
                .Where(e => e.ObjectKey?.ToString() is { } k && !known.Contains(k))
                .Select(e => (e.ObjectKey!.ToString()!, PathOf(reader, e))));
            var Canon = Replacer(tokens);
            var Coarse = Replacer(coarse);
            var canon = new SortedDictionary<string, string>(StringComparer.Ordinal);
            var lines = new List<string>();
            foreach (var ((key, property), value) in values) {
                canon[Canon(key) + " " + property] = Shape(property, value, Canon);
                lines.Add(Coarse(key) + " " + property + "=" + Shape(property, value, Coarse));
            }
            lines.Sort(StringComparer.Ordinal);
            var text = new StringBuilder(Canon(DataDdl.Build((IObjectSignature)candidate, reader, MessageExpectations.Lane, "", 0).Text));
            foreach (var action in ModuleFlow.Build((IObjectSignature)candidate, reader, MessageExpectations.Lane, "", 0).Actions)
                text.Append("\n== ").Append(Canon(action.Name)).Append('\n').Append(Canon(action.Text));
            // integ/proto-into-product: a new key the text writes after @ that neither the walk nor an identity names (the key of
            // an entity's index: the candidate's MergeContentProof names elements by place, never by key) is a key the apply
            // drew, the same element in both applies: written as one token, so only what the line says is compared.
            var written = TextKey.Replace(text.ToString(), m => known.Contains(m.Groups[1].Value) ? m.Value : "@{new key}");
            return new(canon, written, tokens.Keys.Count(k => !Hex64.IsMatch(k)), Coarse, lines);
        }
        finally { ModelHost.Release(@base); ModelHost.Release(candidate); }
    }

    // integ/proto-into-product: what a new element is, by the kind and the display of it and of every owner up to the module.
    // The candidate's MergeContentProof (merge-identity) names an element by its place, never by a local key, so its
    // identities hold no key the rounds of Names could tie to their element; two new elements alike in kind and name (the Id
    // of two new entities) were then told apart only by the walk's order, which follows their random keys and is not the
    // same in two applies. The owners' names tell them apart in every apply.
    private static string PathOf(KernelModelReader reader, IObjectSignature element)
    {
        var parts = new List<string>();
        for (var n = element; n != null && n is not IESpace; n = n.Parent as IObjectSignature) parts.Add(reader.KindOf(n) + ":" + reader.DisplayOf(n));
        parts.Reverse();
        return string.Join("/", parts);
    }

    // A key inside a JSON value is written escaped (+ as its \u escape): read as the key it is.
    private static Dictionary<(string Key, string Property), string> Unescaped(Dictionary<(string Key, string Property), string> values) =>
        values.ToDictionary(p => p.Key, p => p.Value.Replace("\\u002B", "+").Replace("\\u002F", "/"));

    /// <summary>A value with its keys written by <paramref name="name"/>, and the sets MergeContentProof writes in the order of
    /// their keys (the identities a reference names, a set: property, the references of a JSON value such as a switch's
    /// conditions) sorted again once they are written so.</summary>
    private static string Shape(string property, string value, Func<string, string> name)
    {
        if (property == "$references" || property.StartsWith("set:", StringComparison.Ordinal))
            return string.Join("\n", name(value).Split('\n').Distinct().Order(StringComparer.Ordinal));
        if (value.Length > 1 && value[0] is '[' or '{')
            try { return Json(JsonNode.Parse(value), name, null); } catch (System.Text.Json.JsonException) { }
        return name(value);
    }

    private static string Json(JsonNode? node, Func<string, string> name, string? member) => node switch {
        null => "null",
        JsonObject o => "{" + string.Join(",", o.Select(p => "\"" + p.Key + "\":" + Json(p.Value, name, p.Key))) + "}",
        JsonArray a => "[" + string.Join(",", member == "references" ? a.Select(x => Json(x, name, null)).Order(StringComparer.Ordinal) : a.Select(x => Json(x, name, null))) + "]",
        JsonValue v when v.TryGetValue<string>(out var s) => "\"" + name(s) + "\"",
        _ => node.ToJsonString(),
    };

    // A record MergeContentProof names by what it holds (record:, implicit:, list types): a sha256 of content with keys in it.
    private static readonly Regex Hex64 = new(@"(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex NodeLike = new(LocalKey + "|" + Hex64, RegexOptions.Compiled | RegexOptions.CultureInvariant);

    /// <summary>The name of every element the apply created (a key the base does not have, of the walk or of an identity the walk
    /// does not reach) and of every record named by a hash of its content: not the walk's place (the order of a model's
    /// children follows its keys), but what it is. Each starts as its label (MergeContentProof's, and kind:display of the walk);
    /// every round adds what it holds (the values of the identities that name it) and where it is named (the identity and the
    /// property of every value that names it), with the other elements by their names of the round before, until no round
    /// tells more elements apart. Elements still alike are numbered in the walk's order.</summary>
    private static (Dictionary<string, string> Tokens, Dictionary<string, string> Coarse) Names(Dictionary<(string Key, string Property), string> values, Dictionary<string, string> labels,
        HashSet<string> known, IEnumerable<(string Key, string Display)> walked)
    {
        var display = new Dictionary<string, string>(StringComparer.Ordinal);
        var order = new List<string>();
        var listed = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (key, shown) in walked) if (display.TryAdd(key, shown)) order.Add(key);
        bool Named(string id) => Hex64.IsMatch(id) || !known.Contains(id);
        // A new key heads an identity; a hash of content is named in identities and in values ($references) alike.
        foreach (var ((id, _), value) in values) {
            foreach (Match m in NodeLike.Matches(id)) if (Named(m.Value) && !display.ContainsKey(m.Value) && listed.Add(m.Value)) order.Add(m.Value);
            foreach (Match m in Hex64.Matches(value)) if (listed.Add(m.Value)) order.Add(m.Value);
        }
        var nodes = order.ToHashSet(StringComparer.Ordinal);
        var own = nodes.ToDictionary(n => n, _ => new List<(string Id, string Property, string Value)>(), StringComparer.Ordinal);
        var namedBy = nodes.ToDictionary(n => n, _ => new List<(string Id, string Property)>(), StringComparer.Ordinal);
        foreach (var ((id, property), value) in values) {
            // Every element an identity names holds its values (an entity's generated index: the entity and the index's hash).
            foreach (var head in NodeLike.Matches(id).Select(m => m.Value).Distinct(StringComparer.Ordinal))
                if (own.TryGetValue(head, out var held)) held.Add((id, property, value));
            foreach (Match m in NodeLike.Matches(value)) if (namedBy.TryGetValue(m.Value, out var by)) by.Add((id, property));
        }
        string Label(string n) => (labels.GetValueOrDefault(n) ?? (Hex64.IsMatch(n) ? "record" : "element")) + (display.TryGetValue(n, out var d) ? "|" + d : "");
        var name = nodes.ToDictionary(n => n, Label, StringComparer.Ordinal);
        var classes = name.Values.Distinct().Count();
        for (var round = 0; round < 12; round++) {
            var before = name;
            string Sub(string text) => NodeLike.Replace(text, m => before.TryGetValue(m.Value, out var s) ? "<" + s + ">" : m.Value);
            var next = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var n in nodes) {
                var content = new StringBuilder(before[n]);
                foreach (var line in own[n].Select(e => Sub(e.Id) + " " + e.Property + "=" + Shape(e.Property, e.Value, Sub)).Order(StringComparer.Ordinal)) content.Append('\n').Append(line);
                foreach (var line in namedBy[n].Select(e => "<- " + Sub(e.Id) + " " + e.Property).Order(StringComparer.Ordinal)) content.Append('\n').Append(line);
                next[n] = Label(n) + " ~" + Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(content.ToString())))[..12];
            }
            name = next;
            var count = name.Values.Distinct().Count();
            if (count == classes) break;
            classes = count;
        }
        var tokens = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var group in order.GroupBy(n => name[n], StringComparer.Ordinal)) {
            var i = 0;
            foreach (var n in group) tokens[n] = "{new " + group.Key + (group.Count() > 1 ? " #" + ++i : "") + "}";
        }
        return (tokens, nodes.ToDictionary(n => n, n => "{new " + Label(n) + "}", StringComparer.Ordinal));
    }

    /// <summary>The first differences between two readings (at most <paramref name="max"/>), empty when they say the same.</summary>
    internal static List<string> Differences(Reading expected, Reading actual, int max = 20)
    {
        var differences = new List<string>();
        // The lines that differ with each new element by its label alone (a multiset): what really differs, at most half of max.
        var only = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var line in expected.Coarse) only[line] = only.GetValueOrDefault(line) + 1;
        foreach (var line in actual.Coarse) only[line] = only.GetValueOrDefault(line) - 1;
        foreach (var (line, count) in only.Where(p => p.Value != 0).OrderBy(p => p.Key, StringComparer.Ordinal).Take(max / 2))
            differences.Add((count > 0 ? "only before: " : "only after: ") + line);
        foreach (var key in expected.Values.Keys.Union(actual.Values.Keys).Order(StringComparer.Ordinal)) {
            var a = expected.Values.GetValueOrDefault(key); var b = actual.Values.GetValueOrDefault(key);
            if (a != b) differences.Add(key + ": " + (a ?? "(absent)") + " | " + (b ?? "(absent)"));
            if (differences.Count >= max) return differences;
        }
        if (expected.Text != actual.Text) {
            var x = expected.Text.Split('\n'); var y = actual.Text.Split('\n');
            var at = Enumerable.Range(0, Math.Min(x.Length, y.Length)).FirstOrDefault(i => x[i] != y[i], Math.Min(x.Length, y.Length));
            differences.Add("text line " + (at + 1) + ": " + (at < x.Length ? x[at] : "(end)") + " | " + (at < y.Length ? y[at] : "(end)"));
        }
        return differences;
    }
}
