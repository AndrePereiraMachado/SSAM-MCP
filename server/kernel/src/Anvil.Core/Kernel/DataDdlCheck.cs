using System.Text.Json.Nodes;

namespace Anvil.Reading;

// One difference between the model and its data text read back: an element of the model the text does not hold (or holds
// twice, or under another parent, name, kind or place), or a property whose value the text does not give back. Each one
// is an operation the way back would emit for a text it did not change: the fixed point is zero of them.
public sealed record DdlMismatch(string Kind, string Key, string Name, string Property, string? Expected, string? Actual);

// The fixed point of the data text (ssam-ddl/1) over one module: print the text (DataDdl), parse it (DdlParser) and compare
// every data element of the model with the element of the same @key: kind, name, parent, position, every property the
// Model API lets set (with the defaults of DdlRules for what the text leaves out), record values, index columns and call
// arguments. Elements the text does not write because they hold nothing (an ODC sample record or entity event that is
// empty, an index the platform generates) are checked to hold nothing. Properties the Model API does not let set are
// computed by the platform: counted per kind and property (ReadOnly), never compared. Shared by both kernels.
public sealed class DdlCheck
{
    public string Module { get; private init; } = "";
    public string Lane { get; private init; } = "";
    public int Bytes { get; private init; }
    // The blocks of the printed text; -1 when the check read back a text it was given.
    public int Blocks { get; private init; }
    public string? ParseError { get; private init; }
    // Per kind: elements of the model and those read back without a difference.
    public SortedDictionary<string, (int Total, int Exact)> Kinds { get; } = new(StringComparer.Ordinal);
    public List<DdlMismatch> Mismatches { get; } = [];
    // Elements written as nothing because they hold nothing (verified), per kind.
    public SortedDictionary<string, int> Empty { get; } = new(StringComparer.Ordinal);
    // The platform's built-in types the module keeps a copy of at its top (a StructureSignature or StaticEntitySignature
    // outside any Reference: System's Attachment, ODC's AI types), per kind with everything they hold. They are not this
    // module's data: not written, counted.
    public SortedDictionary<string, int> BuiltIn { get; } = new(StringComparer.Ordinal);
    // Values the platform computes (DdlRules.Computed), per kind.property: not written, counted, verified where a rule exists.
    public SortedDictionary<string, int> Computed { get; } = new(StringComparer.Ordinal);
    public int Elements => Kinds.Values.Sum(k => k.Total);
    public int Exact => Kinds.Values.Sum(k => k.Exact);
    public bool FixedPoint => ParseError == null && Mismatches.Count == 0;

    public JsonObject ToJson(int samples = 40)
    {
        var kinds = new JsonObject();
        foreach (var (kind, (total, exact)) in Kinds) kinds[kind] = new JsonObject { ["total"] = total, ["exact"] = exact };
        var byProperty = new JsonObject();
        foreach (var group in Mismatches.GroupBy(m => m.Kind + "." + m.Property).OrderByDescending(g => g.Count()).ThenBy(g => g.Key, StringComparer.Ordinal))
            byProperty[group.Key] = group.Count();
        var sample = new JsonArray();
        foreach (var m in Mismatches.Take(samples))
            sample.Add(new JsonObject { ["kind"] = m.Kind, ["key"] = m.Key, ["name"] = m.Name, ["property"] = m.Property, ["expected"] = m.Expected, ["actual"] = m.Actual });
        return new JsonObject { ["module"] = Module, ["lane"] = Lane, ["bytes"] = Bytes, ["blocks"] = Blocks, ["elements"] = Elements, ["exact"] = Exact,
            ["fixedPoint"] = FixedPoint, ["parseError"] = ParseError, ["kinds"] = kinds, ["mismatches"] = Mismatches.Count, ["byProperty"] = byProperty,
            ["samples"] = sample, ["empty"] = JsonNode.Parse(System.Text.Json.JsonSerializer.Serialize(Empty)),
            ["builtIn"] = JsonNode.Parse(System.Text.Json.JsonSerializer.Serialize(BuiltIn)),
            ["computed"] = JsonNode.Parse(System.Text.Json.JsonSerializer.Serialize(Computed)) };
    }

    // text: the text to read back (an edited one); by default the module's own data text, printed now.
    public static DdlCheck Run<T>(T root, ModelReader<T> reader, string lane, string? text = null) where T : class
    {
        var ddl = text == null ? DataDdl.Build(root, reader, lane, "", 0) : null;
        text ??= ddl!.Text;
        DdlDocument document;
        try { document = DdlParser.Parse(text); }
        catch (FormatException error) {
            return new DdlCheck { Module = reader.DisplayOf(root), Lane = lane, Bytes = System.Text.Encoding.UTF8.GetByteCount(text), Blocks = ddl?.Blocks.Count ?? -1, ParseError = error.Message };
        }
        var check = new DdlCheck { Module = reader.DisplayOf(root), Lane = lane, Bytes = System.Text.Encoding.UTF8.GetByteCount(text), Blocks = ddl?.Blocks.Count ?? -1 };
        new Comparer<T>(reader, check, document).Run(root);
        return check;
    }

    // A text already read (the way back's checks: an edited text whose new elements were given the keys the apply made).
    public static DdlCheck RunDocument<T>(T root, ModelReader<T> reader, string lane, DdlDocument document) where T : class
    {
        var check = new DdlCheck { Module = reader.DisplayOf(root), Lane = lane, Bytes = -1, Blocks = -1 };
        new Comparer<T>(reader, check, document).Run(root);
        return check;
    }

    private sealed class Comparer<T>(ModelReader<T> reader, DdlCheck check, DdlDocument document) where T : class
    {
        private readonly Dictionary<string, DdlElement> parsed = new(StringComparer.Ordinal);
        private readonly HashSet<string> seen = new(StringComparer.Ordinal);
        private string? kind, key, name;
        private bool exact;

        public void Run(T root)
        {
            foreach (var element in document.All()) {
                if (element.Key.Length == 0) { Note(element.Kind, "", element.Name, "@key", "a key", null); continue; }
                if (!parsed.TryAdd(element.Key, element)) Note(element.Kind, element.Key, element.Name, "@key", "once", "twice");
            }
            Visit(root, true);
            // Every element the text declares is an element of the model.
            foreach (var element in document.All())
                if (element.Key.Length > 0 && !seen.Contains(element.Key)) Note(element.Kind, element.Key, element.Name, "element", null, "not in the model");
        }

        // Entities, variables and timers of the module, and its structures wherever they are (an integration holds some);
        // nothing of another module (under a Reference) is the module's.
        private void Visit(T node, bool top)
        {
            foreach (var child in reader.ChildrenOf(node)) {
                var childKind = reader.KindOf(child);
                if (top && childKind is "StructureSignature" or "StaticEntitySignature") { BuiltIn(child); continue; }
                if (childKind == "Reference" || childKind.EndsWith("Signature", StringComparison.Ordinal)) continue;
                if (reader.IsKind(child, "Entity") && DdlRules.IsEntityKind(childKind)) { Entity(child); continue; }
                if (childKind == "Structure") { Structure(child); continue; }
                if (top && DdlRules.VariableKinds.Contains(childKind)) { Declaration(child); continue; }
                if (top && childKind == "Timer") { Timer(child); continue; }
                Visit(child, false);
            }
        }

        private void BuiltIn(T signature)
        {
            foreach (var node in reader.Walk(signature)) {
                var kind = reader.KindOf(node);
                if (kind is "Expression" or "TextBasedExpression" or "IdentifierType" or "EntityActionSignature") continue;
                check.BuiltIn[kind] = check.BuiltIn.GetValueOrDefault(kind) + 1;
            }
        }

        // ---- elements ------------------------------------------------------------------------------------------------

        private void Entity(T entity)
        {
            var element = Begin(entity, null);
            var attributes = reader.ChildrenOf(entity).Where(c => reader.KindOf(c) == "EntityAttribute").ToList();
            var ordered = Listed(entity, "Attributes", attributes);
            if (element != null) {
                Properties(entity, element, new DdlParsedContext(element), ["Identifier", "IdentifierAttribute"]);
                // The identifier attribute: the attribute marked `identifier`.
                var marked = element.Props.GetValueOrDefault("Identifier");
                Compare("Identifier", DdlModel.Text(reader, DdlModel.Raw(reader, entity, "Identifier")), marked);
                if (reader.PropertyOf(entity, "IdentifierAttribute") != null)
                    Compare("IdentifierAttribute", DdlModel.Text(reader, DdlModel.Raw(reader, entity, "IdentifierAttribute")), marked);
            }
            End();
            for (var i = 0; i < ordered.Count; i++) Attribute(ordered[i], element, i, "EntityAttribute");
            foreach (var child in reader.ChildrenOf(entity)) {
                var childKind = reader.KindOf(child);
                if (childKind == "EntityAttribute") continue;
                if (reader.IsKind(child, "Record")) Record(child, entity, element);
                else if (childKind == "EntityIndex") Index(child, entity, element);
                else if (DdlRules.IsEventKind(childKind)) Event(child, entity, element);
            }
            var nodes = reader.IndexNodes(entity);
            foreach (var index in nodes ?? []) Index(index, entity, element);
            // Every index the entity has is one of the elements compared (O11 keeps them outside its children).
            if (nodes != null && reader.Indexes(entity) is { } tuples && tuples.Count != nodes.Count)
                Note(reader.KindOf(entity), reader.KeyOf(entity), reader.DisplayOf(entity), "indexes", tuples.Count + " indexes", nodes.Count + " with a key");
        }

        private void Attribute(T attribute, DdlElement? parent, int position, string attributeKind)
        {
            var element = Begin(attribute, parent);
            if (element != null) {
                var siblings = element.Parent?.Children.Where(c => c.Kind == attributeKind).ToList() ?? [];
                Compare("position", position.ToString(), siblings.IndexOf(element).ToString());
                Properties(attribute, element, new DdlParsedContext(element), []);
                if (element.References != null && element.Props.GetValueOrDefault("DataType") is { } type && type != element.References + " Identifier")
                    Compare("references", type, element.References + " Identifier");
            }
            End();
        }

        private void Record(T record, T entity, DdlElement? parent)
        {
            var sample = reader.KindOf(entity) != "StaticEntity";
            var values = new List<string>();
            var extras = new List<(string Property, string? Text)>();
            foreach (var value in reader.ChildrenOf(record)) {
                if (reader.KindOf(value) != "RecordAttributeValue") continue;
                var attribute = DdlModel.Raw(reader, value, "Attribute") is T a ? reader.NameOf(a) : "?";
                var text = DdlModel.Text(reader, DdlModel.Raw(reader, value, "Value"));
                values.Add(text == null ? "" : attribute + " = " + text);
                foreach (var (property, other) in DdlModel.Compared(reader, value))
                    if (property is not ("Attribute" or "Value") && !DdlRules.Unset(other)) extras.Add((property, other));
            }
            if (sample && !parsed.ContainsKey(reader.KeyOf(record))) {
                // An empty sample record is not written: it must hold nothing.
                var empty = values.All(v => v.Length == 0) && extras.Count == 0 && DdlModel.Compared(reader, record).All(p => DdlRules.Unset(p.Value));
                Empty("Record (sample)", empty, record);
                Parts(values, empty ? values.ToHashSet(StringComparer.Ordinal) : []);
                return;
            }
            var element = Begin(record, parent);
            var read = new HashSet<string>(StringComparer.Ordinal) { "" };
            if (element != null) {
                Compare("name", DdlModel.Text(reader, DdlModel.Raw(reader, record, "Identifier")) ?? (sample ? element.Name : reader.DisplayOf(record)), element.Name);
                Properties(record, element, new DdlParsedContext(element), ["Identifier"]);
                foreach (var (attribute, value) in element.Values) read.Add(attribute + " = " + value);
                Compare("values", string.Join("; ", values.Where(v => v.Length > 0).Order(StringComparer.Ordinal)),
                    string.Join("; ", element.Values.Select(v => v.Attribute + " = " + v.Value).Order(StringComparer.Ordinal)));
                foreach (var (property, other) in extras) Compare("value." + property, other, null);
            }
            End();
            Parts(values, element != null && extras.Count == 0 ? read : []);
        }

        // The values of a record: each one read back when the text gives the same attribute the same expression.
        private void Parts(List<string> values, HashSet<string> read)
        {
            var (total, good) = check.Kinds.GetValueOrDefault("RecordAttributeValue");
            check.Kinds["RecordAttributeValue"] = (total + values.Count, good + values.Count(read.Contains));
        }

        private void Index(T index, T entity, DdlElement? parent)
        {
            var (unique, auto, columns) = DdlModel.IndexOf(reader, entity, index);
            if (auto && !parsed.ContainsKey(reader.KeyOf(index))) {
                // Generated by the platform for a reference attribute: not written.
                Empty("EntityIndex (generated)", true, index);
                return;
            }
            var element = Begin(index, parent);
            if (element != null) {
                Properties(index, element, new DdlParsedContext(element), ["IndexAttributes", "Attributes", "Unique", "AutoGenerated"]);
                Compare("Unique", unique ? "True" : null, element.Props.GetValueOrDefault("Unique"));
                Compare("AutoGenerated", auto ? "True" : null, null);
                Compare("columns", string.Join(", ", columns), string.Join(", ", element.Columns));
                foreach (var part in reader.ChildrenOf(index))
                    foreach (var (property, other) in DdlModel.Compared(reader, part))
                        if (property != "Attribute" && !DdlRules.Unset(other)) Compare("column." + property, other, null);
            }
            End();
        }

        private void Event(T @event, T entity, DdlElement? parent)
        {
            var handler = DdlModel.Text(reader, DdlModel.Raw(reader, @event, "Destination") ?? DdlModel.Raw(reader, @event, "Handler"));
            var arguments = Arguments(@event);
            if (!parsed.ContainsKey(reader.KeyOf(@event))) {
                Empty("entity event", handler == null && arguments.Length == 0 && DdlModel.Compared(reader, @event).All(p => DdlRules.Unset(p.Value)), @event);
                return;
            }
            var element = Begin(@event, parent);
            if (element != null) {
                Compare("handler", handler, element.Props.GetValueOrDefault("Destination"));
                Properties(@event, element, new DdlParsedContext(element), ["Destination", "Handler"]);
                Compare("arguments", arguments, string.Join(", ", element.Arguments.Select(a => a.Parameter + " = " + a.Value).Order(StringComparer.Ordinal)));
            }
            End();
        }

        private void Structure(T structure)
        {
            var element = Begin(structure, null);
            if (element != null) Properties(structure, element, new DdlParsedContext(element), []);
            End();
            var attributes = reader.ChildrenOf(structure).Where(c => reader.KindOf(c) == "StructureAttribute").ToList();
            var ordered = Listed(structure, "Attributes", attributes);
            for (var i = 0; i < ordered.Count; i++) Attribute(ordered[i], element, i, "StructureAttribute");
            foreach (var child in reader.ChildrenOf(structure))
                if (reader.KindOf(child) != "StructureAttribute") Unexpected(child);
        }

        private void Declaration(T variable)
        {
            var element = Begin(variable, null);
            if (element != null) Properties(variable, element, new DdlParsedContext(element), []);
            End();
        }

        private void Timer(T timer)
        {
            var element = Begin(timer, null);
            if (element != null) {
                Properties(timer, element, new DdlParsedContext(element), []);
                Compare("arguments", Arguments(timer), string.Join(", ", element.Arguments.Select(a => a.Parameter + " = " + a.Value).Order(StringComparer.Ordinal)));
                // The timer's own parts (an ODC schedule): what they hold must be what the timer's schedule says.
                foreach (var child in reader.ChildrenOf(timer)) {
                    var childKind = reader.KindOf(child);
                    if (childKind is "Argument" || childKind.EndsWith("Signature", StringComparison.Ordinal)) continue;
                    foreach (var (property, value) in DdlModel.Compared(reader, child))
                        if (!DdlRules.Unset(value)) Compare(childKind + "." + property, value, DdlRules.TimerPart(childKind, property, element.Props.GetValueOrDefault("Schedule")));
                }
            }
            End();
        }

        // A child the text has no place for: a difference.
        private void Unexpected(T node) => check.Mismatches.Add(new(reader.KindOf(node), reader.KeyOf(node), reader.DisplayOf(node), "element", "a place in the text", null));

        // ---- comparison ----------------------------------------------------------------------------------------------

        private DdlElement? Begin(T node, DdlElement? parent)
        {
            kind = reader.KindOf(node); key = reader.KeyOf(node); name = reader.DisplayOf(node); exact = true;
            if (!parsed.TryGetValue(key, out var element)) { Compare("element", "written", null); return null; }
            seen.Add(key);
            var parsedKind = element.Kind;
            if (parsedKind != kind && !(parsedKind == "Record" && kind == "StaticEntityRecord")) Compare("kind", kind, parsedKind);
            if (!reader.IsKind(node, "Record")) Compare("name", reader.NameOf(node), element.Name);
            if (parent != null || element.Parent != null) Compare("parent", parent?.Key, element.Parent?.Key);
            return element;
        }

        private void End()
        {
            if (kind == null) return;
            var (total, good) = check.Kinds.GetValueOrDefault(kind);
            check.Kinds[kind] = (total + 1, good + (exact ? 1 : 0));
            kind = null;
        }

        private void Empty(string what, bool empty, T node)
        {
            check.Empty[what] = check.Empty.GetValueOrDefault(what) + 1;
            if (!empty) check.Mismatches.Add(new(reader.KindOf(node), reader.KeyOf(node), reader.DisplayOf(node), "element", "written (it holds a value)", null));
        }

        private void Compare(string property, string? expected, string? actual)
        {
            if (DdlRules.Same(expected, actual)) return;
            exact = false;
            check.Mismatches.Add(new(kind ?? "?", key ?? "", name ?? "", property, expected, actual));
        }

        private void Note(string noteKind, string noteKey, string noteName, string property, string? expected, string? actual) =>
            check.Mismatches.Add(new(noteKind, noteKey, noteName, property, expected, actual));

        // Every property the text accounts for (DdlModel.Compared): the text's value, or its default when the text leaves it
        // out. A property the text writes that the model does not have is a difference too. What the platform computes
        // (DdlRules.Computed) is counted, and verified where it has a rule.
        private void Properties(T node, DdlElement element, DdlParsedContext context, string[] handled)
        {
            var compared = new HashSet<string>(StringComparer.Ordinal);
            foreach (var (property, value) in DdlModel.Compared(reader, node)) {
                compared.Add(property);
                if (handled.Contains(property)) continue;
                var actual = element.Props.TryGetValue(property, out var written) ? written : DdlRules.Default(context, property);
                Compare(property, value, actual);
            }
            foreach (var property in element.Props.Keys)
                if (!compared.Contains(property) && !handled.Contains(property)) Compare(property, null, element.Props[property] ?? "none");
            foreach (var (property, read) in reader.PropertiesOf(node)) {
                if (!DdlRules.Computed.ContainsKey(property)) continue;
                object? value; try { value = read(); } catch { continue; }
                var text = value is System.Collections.IEnumerable and not string && reader.ExpressionText(value!) == null ? "[list]" : DdlModel.Text(reader, value);
                if (DdlRules.Unset(text)) continue;
                var at = reader.KindOf(node) + "." + property + (reader.IsWritable(node, property) ? " (settable)" : "");
                check.Computed[at] = check.Computed.GetValueOrDefault(at) + 1;
                // The rules: Type is the DataType; LabelOrFirstAttribute is LabelAttribute when that is set.
                if (property == "Type") Compare("Type", DdlModel.Text(reader, DdlModel.Raw(reader, node, "DataType")), text);
                if (property == "LabelOrFirstAttribute" && DdlModel.Text(reader, DdlModel.Raw(reader, node, "LabelAttribute")) is { } label) Compare("LabelOrFirstAttribute", label, text);
            }
        }

        // The attributes in the order of the element's list property, then any child the list leaves out (so that none is
        // left unchecked: the text writes the list).
        private List<T> Listed(T node, string property, List<T> children)
        {
            if (DdlModel.Raw(reader, node, property) is not System.Collections.IEnumerable items || items is string) return children;
            var listed = items.OfType<T>().Where(c => children.Contains(c)).ToList();
            return [.. listed, .. children.Where(c => !listed.Contains(c))];
        }

        private string Arguments(T node) => string.Join(", ", reader.ChildrenOf(node).Where(c => reader.KindOf(c) == "Argument")
            .Select(a => (Parameter: DdlModel.Raw(reader, a, "Parameter") is T p ? reader.NameOf(p) : "?", Value: DdlModel.Text(reader, DdlModel.Raw(reader, a, "Value"))))
            .Where(a => a.Value != null).Select(a => a.Parameter + " = " + a.Value).Order(StringComparer.Ordinal));
    }

}
