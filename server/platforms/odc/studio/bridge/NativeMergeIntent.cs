using OutSystems.Model.Merge;
using ServiceStudio.Model;
using Anvil.Bridge;
using System.Text.Json.Nodes;

// Read-only native comparisons against the actual pre-merge model prove preservation.
internal static class NativeMergeIntent {
    internal sealed record Change(string Key, string Element, string Property, string? Local, string? Delivery, bool Whole, string[] Ancestors);
    internal sealed record Audit(Change[] Preserved, Change[] Replaced) {
        internal bool IsPreserved(Match match, PropertyPair? pair) {
            var key = (match.LocalObject ?? match.ForeignObject ?? match.BaseObject)?.Key.ToString();
            return Preserved.Any(c => c.Key == key && (pair == null ? c.Whole : !c.Whole && c.Property == pair.PropertyName));
        }
        // Keep the selector's causes, and name every otherwise unlisted native side effect.
        internal JsonObject Receipt(JsonObject? selected, Change[] written) {
            var entries = selected?["entries"]?.DeepClone() as JsonArray ?? new JsonArray();
            var conflicts = selected?["conflicts"]?.GetValue<int>() ?? 0;
            var others = selected?["others"]?.GetValue<int>() ?? 0;
            foreach (var change in Replaced) {
                static string? Clip(string? value) => value is { Length: > 200 } ? value[..200] + "..." : value;
                if (entries.Any(e => e?["element"]?.GetValue<string>() == change.Element && e?["property"]?.GetValue<string>() == change.Property
                    && e?["user"]?.GetValue<string>() == Clip(change.Local) && e?["delivery"]?.GetValue<string>() == Clip(change.Delivery))) continue;
                var conflict = written.Any(w => Overlaps(w, change));
                if (conflict) conflicts++; else others++;
                entries.Add(new JsonObject {
                    ["element"] = change.Element, ["property"] = change.Property,
                    ["user"] = change.Local, ["delivery"] = change.Delivery,
                    ["conflict"] = conflict, ["cause"] = "native-merge", ["action"] = "observed replacement"
                });
            }
            var result = selected?.DeepClone() as JsonObject ?? new JsonObject { ["prefer"] = "foreign", ["units"] = 0 };
            result["entries"] = entries; result["conflicts"] = conflicts; result["others"] = others;
            result["count"] = conflicts + others;
            result["truncated"] = selected?["truncated"]?.GetValue<bool>() ?? false;
            return result;
        }
    }
    internal static Audit Observe(ESpace live, ESpace expected, ESpace basis, ESpace before) {
        var written = Read(basis, expected);
        var actual = Read(live, expected);
        var prior = Read(before, expected);
        var changes = Read(before, live);
        var person = Read(basis, before);
        var preserved = actual.Where(a => !written.Any(w => Overlaps(w, a))
            && prior.Any(p => p.Key == a.Key && p.Property == a.Property && p.Whole == a.Whole)
            && !changes.Any(c => Overlaps(c, a))).ToArray();
        var replaced = changes.Where(c => person.Any(p => Overlaps(p, c))).ToArray();
        return new Audit(preserved, replaced);
    }

    internal static bool Overlaps(Change a, Change b) =>
        (a.Key == b.Key && (a.Whole || b.Whole || a.Property == b.Property))
        || (a.Whole && b.Ancestors.Contains(a.Key)) || (b.Whole && a.Ancestors.Contains(b.Key));

    internal static Change[] Read(ESpace local, ESpace foreign) {
        using var tree = new MatchTree(local, foreign, foreign, false, true);
        var changes = new List<Change>();
        var pending = new Stack<Match>(tree.Roots);
        var seen = new HashSet<Match>();
        while (pending.TryPop(out var match)) {
            if (!seen.Add(match)) continue;
            var obj = match.LocalObject ?? match.ForeignObject ?? match.BaseObject;
            if (obj == null) throw new InvalidOperationException("The native merge comparison has no object identity.");
            var key = obj.Key.ToString();
            var element = PreferForeign.PathOf(match);
            var ancestors = new List<string>();
            for (var p = match.Parent; p != null; p = p.Parent)
                ancestors.Add((p.LocalObject ?? p.ForeignObject ?? p.BaseObject).Key.ToString());
            if (match.LocalObject == null || match.ForeignObject == null)
                changes.Add(new(key, element, "", match.LocalObject == null ? "absent" : "present", match.ForeignObject == null ? "absent" : "present", true, ancestors.ToArray()));
            foreach (var pair in match.Properties)
                if (pair.Difference.ToString() != "None")
                    changes.Add(new(key, element, pair.PropertyName, pair.LocalDisplayValue, pair.ForeignDisplayValue, false, ancestors.ToArray()));
            foreach (var child in match.Children) pending.Push(child);
        }
        return changes.ToArray();
    }
}
