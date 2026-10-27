using System.Globalization;
using Anvil.Reading;
using OutSystems.Model;

namespace Anvil.Core;

// F2: the cases of the generated sweep (ModelHost.HtmlRoundTripSweep), derived from the property model of each element.
internal static class ScreenHtmlRoundTrip
{
    internal enum Expectation { Facts, Text, Refused }
    // Written: for a property case, the value the edit writes as the native model must hold it after (the oracle's expectation);
    // Same: the case writes the value the element already holds (the oracle compares with the native value before).
    internal sealed record Case(string Family, string Kind, string? Property, string K, List<string> Edits, string Expected, Expectation Expect, string Note,
        string? Written = null, bool Same = false);

    private static readonly HashSet<string> NotWidgetTags = new(StringComparer.Ordinal) { "screen", "block", "var", "input-parameter", "aggregate", "data-action", "action", "event", "style", "slot", "content", "os-opaque", "text" };

    // The properties the sweep leaves to another test, each with why (the rest is decided by the property model: NotOfThePage,
    // Writable and the type of fact).
    private static readonly (string? Kind, string Property, string Why)[] Exceptions = [
        (null, "Name", "the element's name, written as id (ScreenHtmlEditNamesTests: an element with k keeps its name, a slot's is the Studio's)"),
        (null, "Visible", "owner rule U1: Visible is never written new, a condition is an If around the element (HTML_VISIBLE, refused with its patch)"),
        (null, "Tag", "the element's tag (the C2 battery and the document form)"),
        (null, "StyleSheet", "the stylesheet of the root (the C2 battery's style kind)"),
        ("TextWidget", "Text", "the content of the element (the C2 battery's text kind)"),
        ("TextWidget", "Value", "the content of the element (the C2 battery's text kind)"),
        ("Expression", "Value", "the content of the element (the C2 battery's expression kind)"),
        ("IfWidget", "Condition", "the condition of an If is its if= (the C2 battery's expression kind); if=\"\" is a container"),
        // Measured by this sweep (review round, both lanes): the platform keeps the top margin in the element's inline style, so a
        // MarginTop written also writes margin-top into style= and the Verify refuses the pair, naming both (style and os-MarginTop,
        // expected and actual). The two are one value; which one the text writes is a decision of the language (follow-up).
        (null, "MarginTop", "kept by the platform inside the element's inline style (style= gets margin-top): one value under two attributes, refused by the Verify with both named; not a round trip of its own"),
        ("Image", "Type", "the Type of an Image decides what src is (the static Image, a URL or the binary): the platform drops the static Image when Type changes, the IImage dependency is F3's"),
    ];

    // Values of a dimension a text property of the layout takes (Width, Margin...), when the module itself shows no other one.
    private static readonly string[] Dimensions = ["3 col", "100 px", "50 %"];

    /// <summary>The values every widget property holds in the readings of a module (kind.property -> values), the values the sweep
    /// writes on a text property first: what the platform kept in this module.</summary>
    public static Dictionary<string, SortedSet<string>> Observed(IEnumerable<ScreenHtmlDocument> documents)
    {
        var observed = new Dictionary<string, SortedSet<string>>(StringComparer.Ordinal);
        foreach (var document in documents)
            foreach (var element in document.Canon.Elements.Values)
                foreach (var (fact, value) in element.Facts)
                    if (fact.StartsWith("p:", StringComparison.Ordinal) && value.Length >= 2 && value[0] == 't' && value[1] == ':') {
                        var slot = element.Kind + "." + fact[2..];
                        if (!observed.TryGetValue(slot, out var set)) observed[slot] = set = new SortedSet<string>(StringComparer.Ordinal);
                        set.Add(value[2..]);
                    }
        return observed;
    }

    public static List<Case> Generate(ScreenHtmlModule<IObjectSignature> m, ScreenHtmlDocument doc, SortedDictionary<string, SortedDictionary<string, string>> coverage,
        Dictionary<string, int> taken, int perProperty, int perKindMoves, IReadOnlyDictionary<string, SortedSet<string>>? observed = null)
    {
        var cases = new List<Case>();
        var tree = ScreenHtml.Parse(doc.Html);
        var top = tree.Children.First(c => !c.IsText);
        var parents = ScreenHtmlText.Parents(tree);
        var defaults = m.DefaultsOfRoot(((ScreenHtmlModule<IObjectSignature>.ReadingState)doc.State!).Root);
        var widgets = ScreenHtmlText.Elements(top).Select(x => x.Node)
            .Where(n => n != top && n.Get("k") is { } k && doc.Canon.Elements.TryGetValue(k, out var e) && IsWidget(e.Kind) && !NotWidgetTags.Contains(n.Tag) && !InsideOpaque(n, parents))
            .ToList();
        foreach (var node in widgets) {
            var k = node.Get("k")!;
            var element = doc.Canon.Elements[k];
            var kind = element.Kind;
            var native = m.NodeOf(doc, k);
            if (native == null) continue;
            var model = m.PropertiesOf(native);
            if (!coverage.TryGetValue(kind, out var seen)) coverage[kind] = seen = new SortedDictionary<string, string>(StringComparer.Ordinal);
            foreach (var property in model.Values.OrderBy(p => p.Name, StringComparer.Ordinal)) {
                var skip = Skip(kind, property);
                if (skip != null) { seen.TryAdd(property.Name, "skipped: " + skip); continue; }
                var attribute = ScreenHtmlTables.AttributeOf(kind, property.Name, ScreenHtmlModuleMode.Widget, element.Facts.ContainsKey("p:StyleClasses"));
                if (attribute is "class" or "id" || attribute.StartsWith(':')) { seen.TryAdd(property.Name, "skipped: written as " + attribute + " (the C2 battery's class kind and the names tests)"); continue; }
                var slot = kind + "." + property.Name;
                if (taken.GetValueOrDefault(slot) >= perProperty) continue;
                var fact = element.Facts.GetValueOrDefault("p:" + property.Name);
                var current = ScreenHtmlModule<IObjectSignature>.EffectiveText(defaults, kind, property.Name, fact, property.Type) ?? "";
                var @default = defaults.DefaultOf(kind, property.Name, property.Type);
                var other = Other(property, current, @default, observed?.GetValueOrDefault(slot));
                if (other == null) { seen.TryAdd(property.Name, "skipped: no other value the model or the module names for a " + TypeName(property.Type) + " (" + Clip(current) + ")"); continue; }
                taken[slot] = taken.GetValueOrDefault(slot) + 1;
                seen[property.Name] = "tested";
                // Written again at its effective value (the default written explicitly when the reading leaves it out).
                cases.Add(Set("same", tree, node, k, kind, property.Name, attribute, current, fact == null ? null : current, "the effective value written again", same: true));
                // Another value: read back as written (or absent when it is the default).
                cases.Add(Set("set", tree, node, k, kind, property.Name, attribute, other, other == @default ? null : other, "another value (" + Clip(other) + ")"));
                // The default written explicitly when the element holds another value: the same as leaving it out.
                if (current != @default) cases.Add(Set("default", tree, node, k, kind, property.Name, attribute, @default, null, "the default written explicitly"));
            }
            // Negative: a property the native model has and the page does not keep, one without a setter, a value outside its
            // enumeration: refused with the element and the property named (once per kind).
            Negative(cases, taken, "not-kept", kind, model.Values.FirstOrDefault(p => p.NotOfThePage != null && p.Members != null && p.Name != "Name"), tree, node, k, p => p.Members![^1]);
            Negative(cases, taken, "read-only", kind, model.Values.FirstOrDefault(p => p.NotOfThePage == null && !p.Writable && p.Type is 'b' or 'v' or 't'), tree, node, k, p => p.Type == 'b' ? "True" : "SsamF2");
            Negative(cases, taken, "invalid-value", kind, model.Values.FirstOrDefault(p => p.NotOfThePage == null && p.Writable && p.Members is { Count: > 0 }), tree, node, k, _ => "SsamNotAMember");
            // Move: into a new container where it stands; its identity and its uses go with it.
            if (parents.TryGetValue(node, out var parent) && parent.Tag is not ("table" or "tr" or "thead" or "tbody") && node.Tag is not ("th" or "td" or "tr")
                && taken.GetValueOrDefault("move." + kind) < perKindMoves) {
                taken["move." + kind] = taken.GetValueOrDefault("move." + kind) + 1;
                var copy = Clone(tree, node, out var mine, out var copyParents);
                var holder = copyParents[mine];
                var wrapper = new ScreenHtml.Node { Tag = "div" };
                wrapper.Attributes.Add(new("class", "ssam-f2-wrap"));
                // An If and its <div else> are one element: they move together.
                var elseNode = ElseOf(mine, holder);
                var at = holder.Children.IndexOf(mine);
                holder.Children[at] = wrapper;
                wrapper.Children.Add(mine);
                if (elseNode != null) { holder.Children.Remove(elseNode); wrapper.Children.Add(elseNode); }
                cases.Add(new Case("move", kind, null, k, [ScreenHtmlText.Write(EditRoot(copy, holder, copyParents))], ScreenHtmlText.WithoutKeys(ScreenHtmlText.Write(copy)), Expectation.Text, "moved into a new container"));
            }
            // Negative: into a leaf of the page, which holds no widget. The leaf is one the platform's own drop test
            // (ObjectCloner.CloneAllowed) refuses the widget into, with every inner content of it: the native rule, never a list of
            // kinds. Never the element itself, an element inside it or one it is inside (an If's <div else> is the If's).
            if (parents.ContainsKey(node) && taken.GetValueOrDefault("illegal-container." + kind) < 1) {
                var leaf = widgets.FirstOrDefault(w => w != node && !ScreenHtml.VoidTags.Contains(w.Tag) && w.Children.All(c => c.IsText) && !IsAncestor(node, w, parents) && !IsAncestor(w, node, parents)
                    && m.NodeOf(doc, w.Get("k")!) is ServiceStudio.Model.AbstractObject target && native is ServiceStudio.Model.AbstractObject source
                    && new[] { target }.Concat(target.DirectChildren).All(c => StudioAdapter.Runtime.ImportsChild(c, source) == null));
                if (leaf != null) {
                    var copy2 = Clone(tree, node, out var mine2, out var parents2);
                    var leafCopy = ScreenHtmlText.Elements(copy2).First(x => x.Node.Get("k") == leaf.Get("k")).Node;
                    var siblings = parents2[mine2];
                    var else2 = ElseOf(mine2, siblings);
                    siblings.Children.Remove(mine2);
                    leafCopy.Children.Add(mine2);
                    if (else2 != null) { siblings.Children.Remove(else2); leafCopy.Children.Add(else2); }
                    var text = ScreenHtmlText.Write(copy2.Children.First(c => !c.IsText));
                    // The text holds the element (and its else) inside the leaf: the case moves it, it never removes it.
                    var check = ScreenHtmlText.Elements(ScreenHtml.Parse(text)).Select(x => x.Node).FirstOrDefault(n => n.Get("k") == leaf.Get("k"));
                    if (check != null && check.Children.Any(c => c.Get("k") == k)) {
                        taken["illegal-container." + kind] = 1;
                        cases.Add(new Case("illegal-container", kind, null, k, [text], "", Expectation.Refused, "moved into the " + doc.Canon.Elements[leaf.Get("k")!].Kind + " k=" + leaf.Get("k")));
                    }
                }
            }
            // Negative: a widget something outside it still uses, removed.
            if (taken.GetValueOrDefault("delete-in-use." + kind) < 1 && parents.ContainsKey(node) && m.UsedOutside(doc, k) && node.Tag is not ("th" or "td")) {
                taken["delete-in-use." + kind] = 1;
                var copy3 = Clone(tree, node, out var mine3, out var parents3);
                var holder3 = parents3[mine3];
                var else3 = ElseOf(mine3, holder3);
                holder3.Children.Remove(mine3);
                if (else3 != null) holder3.Children.Remove(else3);
                cases.Add(new Case("delete-in-use", kind, null, k, [ScreenHtmlText.Write(copy3.Children.First(c => !c.IsText))], "", Expectation.Refused, "removed while used"));
            }
        }
        return cases;
    }

    private static void Negative(List<Case> cases, Dictionary<string, int> taken, string family, string kind, ScreenHtmlModule<IObjectSignature>.PropertyModel? property,
        ScreenHtml.Node tree, ScreenHtml.Node node, string k, Func<ScreenHtmlModule<IObjectSignature>.PropertyModel, string> value)
    {
        if (property == null || taken.GetValueOrDefault(family + "." + kind) >= 1) return;
        taken[family + "." + kind] = 1;
        Clone(tree, node, out var mine, out _);
        var attribute = "os-" + property.Name;
        mine.Attributes.RemoveAll(a => a.Key == attribute);
        mine.Attributes.Add(new(attribute, value(property)));
        cases.Add(new Case(family, kind, property.Name, k, [ScreenHtmlText.Write(mine)], "", Expectation.Refused, attribute + "=\"" + value(property) + "\""));
    }

    private static Case Set(string family, ScreenHtml.Node tree, ScreenHtml.Node node, string k, string kind, string property, string attribute, string written, string? readBack, string note, bool same = false)
    {
        var copy = Clone(tree, node, out var mine, out _);
        mine.Attributes.RemoveAll(a => a.Key == attribute);
        mine.Attributes.Add(new(attribute, written));
        var expected = ScreenHtmlText.Clone(copy);
        var target = ScreenHtmlText.Elements(expected).First(x => x.Node.Get("k") == k).Node;
        target.Attributes.RemoveAll(a => a.Key == attribute);
        if (readBack != null) target.Attributes.Add(new(attribute, readBack));
        // The value as the native model holds it (the decoder's one translation of a value attribute: the type of an input).
        var native = kind == "Input" && property == "InputType" ? ScreenHtmlTables.InputTypeIn(written) : written;
        // An Expression left with nothing of its own but its value is a run of its parent (the reading's rule): the text, without k.
        if (kind == "Expression" && target.Children.Count == 0 && target.Attributes.All(a => a.Key is "k" or "value") && target.Get("value") is { } value) {
            var parents = ScreenHtmlText.Parents(expected);
            var holder = parents[target];
            holder.Children[holder.Children.IndexOf(target)] = new ScreenHtml.Node { Text = "{{ " + value + " }}" };
            return new Case(family, kind, property, k, [ScreenHtmlText.Write(mine)], ScreenHtmlText.WithoutKeys(ScreenHtmlText.Write(expected)), Expectation.Text, attribute + ": " + note + " (reads back as a run)", native, same);
        }
        return new Case(family, kind, property, k, [ScreenHtmlText.Write(mine)], ScreenHtmlText.Write(expected), Expectation.Facts, attribute + ": " + note, native, same);
    }

    // The value another than the current one: the other boolean, another member of the enumeration, another literal of the same
    // kind for an expression, for a text another value the module itself holds for that property (else a dimension for a layout
    // property, else a plain text); null when there is none.
    private static string? Other(ScreenHtmlModule<IObjectSignature>.PropertyModel property, string current, string @default, SortedSet<string>? observed)
    {
        switch (property.Type) {
            case 'b': return current == "True" ? "False" : "True";
            case 'v':
                if (property.Members is { Count: > 1 } members) return members.FirstOrDefault(v => v != current && v != "Null") ?? members.First(v => v != current);
                return int.TryParse(current.Length == 0 ? @default : current, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) ? (n + 1).ToString(CultureInfo.InvariantCulture) : null;
            case 'e':
                if (current is "True" or "False") return current == "True" ? "False" : "True";
                if (int.TryParse(current, NumberStyles.Integer, CultureInfo.InvariantCulture, out var i)) return (i + 1).ToString(CultureInfo.InvariantCulture);
                if (current.Length >= 2 && current[0] == '"' && current[^1] == '"' && !current[1..^1].Contains('"')) return "\"ssam-f2\"";
                return null;
            case 't':
                if (observed?.FirstOrDefault(v => v != current && v != @default) is { } kept) return kept;
                if (IsLayout(property.Name)) return Dimensions.First(d => d != current);
                return current == "SsamF2 text" ? "SsamF2 other" : "SsamF2 text";
            default: return null;
        }
    }
    private static bool IsLayout(string name) => name.Contains("Width", StringComparison.Ordinal) || name.Contains("Margin", StringComparison.Ordinal)
        || name.Contains("Height", StringComparison.Ordinal) || name.Contains("Padding", StringComparison.Ordinal);

    // What the property model says no edit writes, then the named exceptions.
    private static string? Skip(string kind, ScreenHtmlModule<IObjectSignature>.PropertyModel property)
    {
        if (property.NotOfThePage != null) return "not a property of the page: " + property.NotOfThePage;
        if (!property.Writable) return "no setter in the Model API: " + property.ReadOnly;
        if (property.Type is 'r' or 'l') return "a reference to another element (its values are the module's elements: F3)";
        foreach (var (k, p, why) in Exceptions) if ((k == null || k == kind) && p == property.Name) return why;
        return null;
    }

    private static bool IsWidget(string kind) => ScreenHtml.WidgetTags.ContainsKey(kind) || kind is "List" or "AdvancedHtml";
    private static bool InsideOpaque(ScreenHtml.Node node, Dictionary<ScreenHtml.Node, ScreenHtml.Node> parents)
    {
        for (var p = parents.GetValueOrDefault(node); p != null; p = parents.GetValueOrDefault(p)) if (p.Tag == "os-opaque") return true;
        return false;
    }
    // The <div else> of an If, the next element of its parent (null: none).
    private static ScreenHtml.Node? ElseOf(ScreenHtml.Node node, ScreenHtml.Node parent)
    {
        var at = parent.Children.IndexOf(node);
        var next = at < 0 ? null : parent.Children.Skip(at + 1).FirstOrDefault(c => !c.IsText);
        return next != null && ScreenHtmlEdit.IsIfElse(node, next) ? next : null;
    }
    // The element a node is inside, where the <div else> of an If is the If's (its False branch).
    private static ScreenHtml.Node? Up(ScreenHtml.Node node, Dictionary<ScreenHtml.Node, ScreenHtml.Node> parents)
    {
        var parent = parents.GetValueOrDefault(node);
        if (parent == null || parent.Tag != "div" || parent.Attributes is not [{ Key: "else" }] || parents.GetValueOrDefault(parent) is not { } holder) return parent;
        var at = holder.Children.IndexOf(parent);
        var before = holder.Children.Take(at).LastOrDefault(c => !c.IsText);
        return before != null && ScreenHtmlEdit.IsIfElse(before, parent) ? before : parent;
    }
    private static bool IsAncestor(ScreenHtml.Node ancestor, ScreenHtml.Node node, Dictionary<ScreenHtml.Node, ScreenHtml.Node> parents)
    {
        for (var p = Up(node, parents); p != null; p = Up(p, parents)) if (ReferenceEquals(p, ancestor)) return true;
        return false;
    }
    // The nearest element with a k that holds the change (the edit names elements of the reading by k).
    private static ScreenHtml.Node EditRoot(ScreenHtml.Node copy, ScreenHtml.Node holder, Dictionary<ScreenHtml.Node, ScreenHtml.Node> parents)
    {
        for (var p = holder; p != null; p = parents.GetValueOrDefault(p))
            if (p.Get("k") != null && p.Tag is not ("slot")) return p;
        return copy.Children.First(c => !c.IsText);
    }
    private static ScreenHtml.Node Clone(ScreenHtml.Node tree, ScreenHtml.Node original, out ScreenHtml.Node mine, out Dictionary<ScreenHtml.Node, ScreenHtml.Node> parents)
    {
        var copy = ScreenHtmlText.Clone(tree);
        var map = new Dictionary<ScreenHtml.Node, ScreenHtml.Node>(ReferenceEqualityComparer.Instance);
        void Pair(ScreenHtml.Node a, ScreenHtml.Node b) { map[a] = b; for (var i = 0; i < a.Children.Count; i++) Pair(a.Children[i], b.Children[i]); }
        Pair(tree, copy);
        mine = map[original];
        parents = ScreenHtmlText.Parents(copy);
        return copy;
    }
    private static string TypeName(char type) => type switch { 'e' => "expression", 't' => "text", 'v' => "value", 'b' => "boolean", _ => "property" };
    private static string Clip(string s) => s.Length > 40 ? s[..40] + "…" : s;
}
