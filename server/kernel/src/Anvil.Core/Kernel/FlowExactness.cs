namespace Anvil.Reading;

/// <summary>
/// Family F5: how the action a text wrote is compared with the text (ModelSession.ApplyFlowText), by structure and meaning,
/// never by the spelling of a node's name:
/// <list type="bullet">
/// <item>a node the platform named otherwise than the text keeps the platform's name, deterministic and unique, with every
/// expression of the action that reads it, only when no element of its scope holds the text's name; when one does (a
/// parameter or local, another node, a variable of its screen, an element of the module) the text's name says two things,
/// and the session refuses it naming both (FLOW_NODE_NAME_TAKEN);</item>
/// <item>an expression the platform keeps with another case of a name (OutSystems names have no case) is the same
/// expression;</item>
/// <item>what still differs is a real difference: one problem per element, naming the element (its id in the text), the
/// property, what the text says and what the action reads.</item>
/// </list>
/// Pure functions over the canonical model (FlowItem): the same two models give the same answer.
/// </summary>
public static class FlowExactness
{
    /// <summary>One difference: the element (its id in the text when it has one), what it is, the property (Name, a value,
    /// a connector, a part), the text's value and the action's.</summary>
    public sealed record Difference(string? Id, string Element, string Property, string? Expected, string? Actual)
    {
        public string Message => $"{(Id != null ? "@" + Id + " " : "")}{Element}: {Property} reads {Show(Actual)}, the text says {Show(Expected)}";
        private static string Show(string? value) => value == null ? "nothing" : "`" + (value.Length <= 160 ? value : value[..160] + "…") + "`";
    }

    /// <summary>A node the platform named otherwise than the text: its key, the text's name, the platform's, and the element of
    /// its scope that holds the text's name (null: none the session can find, the platform's name is taken).</summary>
    public sealed record NodeName(string Key, string Asked, string Given, string? Holder);

    /// <summary>The nodes of <paramref name="read"/> whose name the platform gave instead of the expected one (same key). When
    /// no element of the node's scope holds the text's name (a parameter or local of the action, another node, or what
    /// <paramref name="holderOf"/> finds: a variable of its screen, an element of the module), the expected takes the given
    /// name and the expressions of the action that read the text's name read the given one. When one does, the text's name
    /// says two things: nothing is adopted and the answer names the holder (the caller refuses it).</summary>
    public static List<NodeName> AdoptNodeNames(FlowItem expected, FlowItem read, Func<string, string?>? holderOf = null)
    {
        var answer = new List<NodeName>();
        var got = read.Items.Where(i => i.Role == "node").GroupBy(i => i.Key, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        foreach (var node in expected.Items.Where(i => i.Role == "node" && !i.Opaque && i.Name.Length > 0).ToList())
        {
            if (!got.TryGetValue(node.Key, out var now) || now.Kind != node.Kind || now.Name.Length == 0 || string.Equals(now.Name, node.Name, StringComparison.Ordinal)) continue;
            // Another node of the text already has the given name: the platform's name is not this node's alone.
            if (expected.Items.Any(i => i.Role == "node" && !ReferenceEquals(i, node) && string.Equals(i.Name, now.Name, StringComparison.OrdinalIgnoreCase))) continue;
            var asked = node.Name;
            var holder = expected.Items.FirstOrDefault(i => i.Role is "in" or "out" or "local" && string.Equals(i.Name, asked, StringComparison.OrdinalIgnoreCase)) is { } declared
                ? (declared.Role == "local" ? "the local " : declared.Role == "in" ? "the input " : "the output ") + declared.Name + " of this action"
                : expected.Items.FirstOrDefault(i => i.Role == "node" && !ReferenceEquals(i, node) && string.Equals(i.Name, asked, StringComparison.OrdinalIgnoreCase)) is { } other
                    ? "the node " + other.Name + " (" + other.Kind + ") of this action"
                    : holderOf?.Invoke(asked);
            if (holder != null) { answer.Add(new(node.Key, asked, now.Name, holder)); continue; }
            node.Name = now.Name;
            Rewrite(expected, asked, now.Name);
            answer.Add(new(node.Key, asked, now.Name, null));
        }
        return answer;
    }
    // Every expression of the item and its parts with the name `from` (outside literals, after no dot, never a call `from(`
    // of a function of that name) written `to`.
    private static void Rewrite(FlowItem item, string from, string to)
    {
        foreach (var (name, value) in item.Props.ToList())
            if (value.Type == 'e' && FlowEdits.RenamedNode(value.Text, from, to) is var renamed && renamed != value.Text) item.Props[name] = new('e', renamed);
        foreach (var child in item.Items) Rewrite(child, from, to);
    }

    /// <summary>The expressions of <paramref name="expected"/> that the action keeps with another case of a name (outside
    /// text literals; the same text otherwise): the expected takes the action's form. Answers each (element, from, to).</summary>
    public static List<(string Element, string From, string To)> AdoptNameCase(FlowItem expected, FlowItem read)
    {
        var changed = new List<(string, string, string)>();
        var got = read.Items.Where(i => FlowItem.Keyed(i.Role)).GroupBy(i => i.Key, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        void Pair(FlowItem want, FlowItem have, string where)
        {
            foreach (var (name, value) in want.Props.ToList())
                if (value.Type == 'e' && have.Props.TryGetValue(name, out var other) && other.Type == 'e' && other.Text != value.Text && SameButCase(value.Text, other.Text))
                {
                    want.Props[name] = other;
                    changed.Add((where + " " + name, value.Text, other.Text));
                }
            foreach (var role in want.Items.Where(p => !FlowItem.Keyed(p.Role)).Select(p => p.Role).Distinct().ToList())
            {
                var mine = want.Items.Where(p => p.Role == role).ToList();
                var theirs = have.Items.Where(p => p.Role == role).ToList();
                if (mine.Count != theirs.Count) continue;
                for (var k = 0; k < mine.Count; k++) Pair(mine[k], role == "argument" ? theirs.FirstOrDefault(t => t.Name == mine[k].Name) ?? theirs[k] : theirs[k], where + " " + role);
            }
        }
        Pair(expected, read, "action");
        foreach (var item in expected.Items.Where(i => FlowItem.Keyed(i.Role)))
            if (got.TryGetValue(item.Key, out var have)) Pair(item, have, item.Role + " " + (item.Name.Length > 0 ? item.Name : item.Kind));
        return changed;
    }

    /// <summary>Two expressions that differ only by the case of names (outside "text" literals, which keep their case).</summary>
    public static bool SameButCase(string a, string b)
    {
        if (a.Length != b.Length) return false;
        var literal = false;
        for (var i = 0; i < a.Length; i++)
        {
            if (a[i] == '"') { if (b[i] != '"') return false; literal = !literal; continue; }
            if (literal ? a[i] != b[i] : char.ToUpperInvariant(a[i]) != char.ToUpperInvariant(b[i])) return false;
        }
        return true;
    }

    /// <summary>Every difference between the expected action and the action as it reads, element by element (by key): the
    /// action's own properties, a parameter, local or node the text writes and the action has not (or has and the text does
    /// not write), a name, a property, a connector, a part (an assignment, an argument, a case...). <paramref name="idOf"/>: the
    /// id of the text of a model key (null when it has none).</summary>
    public static List<Difference> Differences(FlowItem expected, FlowItem read, Func<string, string?> idOf, int max = 12)
    {
        var found = new List<Difference>();
        string Label(FlowItem item) => item.Role == "node" ? item.Kind + (item.Name.Length > 0 ? " " + item.Name : "") : item.Role + " " + item.Name;
        void Compare(FlowItem want, FlowItem have, string? id, string element)
        {
            if (want.Name != have.Name) found.Add(new(id, element, "Name", want.Name, have.Name));
            if (want.Kind != have.Kind) found.Add(new(id, element, "kind", want.Kind, have.Kind));
            foreach (var name in want.Props.Keys.Union(have.Props.Keys).Order(StringComparer.Ordinal))
            {
                var w = want.Props.TryGetValue(name, out var x) ? x.Text : null;
                var h = have.Props.TryGetValue(name, out var y) ? y.Text : null;
                if (w != h || x?.Type != y?.Type) found.Add(new(id, element, name, w, h));
            }
            foreach (var edge in want.Edges.Keys.Union(have.Edges.Keys).Order(StringComparer.Ordinal))
            {
                var w = want.Edges.GetValueOrDefault(edge); var h = have.Edges.GetValueOrDefault(edge);
                if (w != h) found.Add(new(id, element, "connector " + edge, w is { Length: > 0 } a ? "@" + (idOf(a) ?? a) : w, h is { Length: > 0 } b ? "@" + (idOf(b) ?? b) : h));
            }
            foreach (var role in want.Items.Concat(have.Items).Where(p => !FlowItem.Keyed(p.Role)).Select(p => p.Role).Distinct().Order(StringComparer.Ordinal))
            {
                var mine = want.Items.Where(p => p.Role == role).Select(p => p.Canon().TrimEnd('\n')).ToList();
                var theirs = have.Items.Where(p => p.Role == role).Select(p => p.Canon().TrimEnd('\n')).ToList();
                if (FlowItem.Unordered(role)) { mine.Sort(StringComparer.Ordinal); theirs.Sort(StringComparer.Ordinal); }
                for (var k = 0; k < Math.Max(mine.Count, theirs.Count); k++)
                {
                    var w = k < mine.Count ? mine[k] : null; var h = k < theirs.Count ? theirs[k] : null;
                    if (w != h) { found.Add(new(id, element, role + " " + (k + 1), w, h)); break; }
                }
            }
        }
        Compare(expected, read, null, "the action " + expected.Name);
        var have = read.Items.Where(i => FlowItem.Keyed(i.Role)).GroupBy(i => i.Key, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        var want = expected.Items.Where(i => FlowItem.Keyed(i.Role)).Select(i => i.Key).ToHashSet(StringComparer.Ordinal);
        foreach (var item in expected.Items.Where(i => FlowItem.Keyed(i.Role)))
        {
            var id = idOf(item.Key);
            if (!have.TryGetValue(item.Key, out var now)) { found.Add(new(id, Label(item), "element", item.Canon().Split('\n')[0].Trim(), null)); continue; }
            Compare(item, now, id, Label(item));
        }
        foreach (var extra in read.Items.Where(i => FlowItem.Keyed(i.Role) && !want.Contains(i.Key)))
            found.Add(new(idOf(extra.Key), Label(extra), "element", null, extra.Canon().Split('\n')[0].Trim()));
        return found.Take(max).ToList();
    }
}
