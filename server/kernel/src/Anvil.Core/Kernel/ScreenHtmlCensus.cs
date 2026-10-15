using System.Collections;
using System.Globalization;
using System.Text.Json.Nodes;

namespace Anvil.Reading;

// Census of what the screens and blocks of a module hold, read through ModelReader like the rich index but without its
// skip list: per kind of node under a screen or block (outside the screen actions), every property with the type of its
// value and its most frequent values, and the kinds of the children of each kind. It measures the ssam-html/1 tables
// (ScreenHtml) against real modules; it writes nothing and changes nothing.
public static class ScreenHtmlCensus
{
    public static JsonObject Run<T>(T module, ModelReader<T> reader) where T : class
    {
        var kinds = new SortedDictionary<string, KindStats>(StringComparer.Ordinal);
        var parentOf = new Dictionary<T, T>(ReferenceEqualityComparer.Instance);
        foreach (var node in reader.Walk(module))
            foreach (var child in reader.ChildrenOf(node)) parentOf.TryAdd(child, node);
        string Role(T node) { var d = reader.Describe(node); return ModuleIndex.Roles[ModuleIndex.RoleOf(d.Kind, new HashSet<string>(d.Kinds, StringComparer.Ordinal))]; }
        foreach (var node in reader.Walk(module)) {
            var role = Role(node);
            if (role is not ("screen" or "block")) continue;
            Visit(node, true);
        }
        void Visit(T node, bool root)
        {
            var kind = reader.KindOf(node) + "[" + Role(node) + "]";
            if (!kinds.TryGetValue(kind, out var stats)) kinds[kind] = stats = new KindStats();
            stats.Count++;
            foreach (var (name, read) in reader.PropertiesOf(node)) {
                if (ModelReader<T>.IsNoise(name)) continue;
                string type, text;
                try {
                    var value = read();
                    (type, text) = value switch {
                        null => ("null", ""),
                        byte[] bytes => ("binary", bytes.Length.ToString(CultureInfo.InvariantCulture)),
                        _ when reader.ExpressionText(value) is { } expression => ("e", expression),
                        T target => ("r", ReferenceEquals(target, node) ? "(self)" : parentOf.TryGetValue(node, out var p) && ReferenceEquals(p, target) ? "(parent)"
                            : parentOf.TryGetValue(target, out var tp) && ReferenceEquals(tp, node) ? "(child " + reader.KindOf(target) + ")" : reader.KindOf(target) + ":" + reader.DisplayOf(target)),
                        string s => ("t", s),
                        bool b => ("b", b ? "True" : "False"),
                        IEnumerable items => ("list", List(items, node)),
                        IFormattable f => ("v:" + value.GetType().Name, f.ToString(null, CultureInfo.InvariantCulture)),
                        _ => ("o:" + value.GetType().Name, value.ToString() ?? "")
                    };
                } catch (Exception error) { (type, text) = ("error", error.GetBaseException().GetType().Name); }
                stats.Add(name, type, text);
            }
            foreach (var child in reader.ChildrenOf(node)) {
                var childRole = Role(child);
                stats.Child(reader.KindOf(child) + "[" + childRole + "]");
                // The bodies of screen actions, data actions and their flows belong to the logic text, not to the page.
                if (childRole is "action" or "flowNode") continue;
                Visit(child, false);
            }
        }
        string List(IEnumerable items, T owner)
        {
            var parts = new List<string>(); var count = 0;
            foreach (var item in items) {
                count++;
                if (parts.Count >= 3) continue;
                parts.Add(item is T element ? (parentOf.TryGetValue(element, out var p) && ReferenceEquals(p, owner) ? "(child " + reader.KindOf(element) + ")" : reader.KindOf(element) + ":" + reader.DisplayOf(element)) : item?.ToString() ?? "null");
            }
            return count + "[" + string.Join(", ", parts) + "]";
        }
        var json = new JsonObject();
        foreach (var (kind, stats) in kinds) json[kind] = stats.Json();
        return json;
    }

    private sealed class KindStats
    {
        public int Count;
        private readonly SortedDictionary<string, SortedDictionary<string, (int Count, Dictionary<string, int> Values)>> props = new(StringComparer.Ordinal);
        private readonly SortedDictionary<string, int> children = new(StringComparer.Ordinal);
        public void Add(string name, string type, string text)
        {
            if (!props.TryGetValue(name, out var byType)) props[name] = byType = new(StringComparer.Ordinal);
            if (!byType.TryGetValue(type, out var entry)) entry = (0, new Dictionary<string, int>(StringComparer.Ordinal));
            var clipped = text.Length > 80 ? text[..80] + "…" : text;
            entry.Values[clipped] = entry.Values.GetValueOrDefault(clipped) + 1;
            byType[type] = (entry.Count + 1, entry.Values);
        }
        public void Child(string kind) => children[kind] = children.GetValueOrDefault(kind) + 1;
        public JsonObject Json()
        {
            var p = new JsonObject();
            foreach (var (name, byType) in props) {
                var t = new JsonObject();
                foreach (var (type, entry) in byType) {
                    var values = new JsonObject { ["count"] = entry.Count, ["distinct"] = entry.Values.Count };
                    foreach (var (value, n) in entry.Values.OrderByDescending(v => v.Value).ThenBy(v => v.Key, StringComparer.Ordinal).Take(6)) values["=" + value] = n;
                    t[type] = values;
                }
                p[name] = t;
            }
            var c = new JsonObject(); foreach (var (kind, n) in children) c[kind] = n;
            return new JsonObject { ["count"] = Count, ["children"] = c, ["properties"] = p };
        }
    }
}
