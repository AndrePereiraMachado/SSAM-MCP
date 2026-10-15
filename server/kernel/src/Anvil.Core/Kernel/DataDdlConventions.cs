namespace Anvil.Reading;

// What the platform (or the engine's spec) fills by itself for an entity, given one meaning in the data text (ssam-ddl/1)
// whether the text writes it or not, before any round of the way back compiles it (the family of 2026-10-12: a static
// entity written without Order, or records without `Id =`, were refused four times in a row, VisitaCerta_CS). The edit is
// changed in place, so every round compiles the same text, and each change is a note; what has no meaning is refused once,
// with every problem and its line. Both lanes, new and kept statements:
//   - the identifier attribute is always required (a primary key): a new one written without `required` is required; a kept
//     one keeps what the module has;
//   - a static entity's identifier is never AutoNumber (the spec's rule and the job's static checks; the ODC Studio refuses it
//     live and the Verify does not see it): `auto` on it is dropped, unless the module already has it so (O11 modules made
//     before the rule keep theirs, and their records have no value of it);
//   - a static entity's record value the text leaves out, for its identifier (Integer, not auto), its label attribute (Text)
//     and its order attribute (Integer), and for any required attribute: a kept record keeps the value the module has; else
//     the identifier takes the next free integer (a new entity from 1, so its position when no record gives one; a kept
//     one after the largest id it has or the text gives), the label the record's name, the order its position in the list,
//     a required attribute its default; a required value with none of those is refused (DDL_VALUE_REQUIRED). Any other
//     value left out is empty, as the text says;
//   - a static entity takes no index (its records are fixed in the module): an index on it is dropped, after its columns are
//     checked against the records (a unique index whose records repeat a value is refused with the line);
//   - a kept static entity's label or order attribute left out of its statement (a statement written from memory) would be
//     deleted with every record's value of it: refused once when the records have values (DDL_STATIC_ATTRIBUTE_LEFT_OUT, the
//     patch is its line as the module has it), unless the statement writes `label none` / `order none`; a note otherwise.
// `current` is the module's text now; null in the static checks of a job (only what the text itself decides).
public static class DdlConventions
{
    public sealed record Note(string Code, string Message);

    public sealed class Result
    {
        public List<Note> Notes { get; } = [];
        public List<DdlProblem> Problems { get; } = [];
    }

    public static Result Apply(DdlDocument edit, DdlDocument? current)
    {
        var result = new Result();
        var byKey = new Dictionary<string, DdlElement>(StringComparer.Ordinal);
        if (current != null) foreach (var element in current.All()) if (element.Key.Length > 0) byKey.TryAdd(element.Key, element);
        foreach (var entity in edit.Elements.Where(e => !e.Drop && DdlRules.IsEntityKind(e.Kind))) {
            // A kept statement is judged against the module (without it, only what the text itself decides).
            DdlElement? was = null;
            if (entity.Key.Length > 0 && (!byKey.TryGetValue(entity.Key, out was) || was.Kind != entity.Kind)) {
                if (current != null) continue;   // a foreign or changed element: the compiler refuses it with its own problem
                was = null;
            }
            Identifier(entity, was, result);
            if (entity.Kind != "StaticEntity") continue;
            if (was != null && current != null) LinkedLeftOut(entity, was, edit.Text, current.Text, result);
            Records(entity, was, current != null, result);
            Indexes(entity, was, edit.Text, result);
        }
        return result;
    }

    // ---- the identifier ------------------------------------------------------------------------------------------------------

    private static void Identifier(DdlElement entity, DdlElement? was, Result result)
    {
        if (entity.Props.GetValueOrDefault("Identifier") is not { } name) return;
        if (entity.Children.FirstOrDefault(c => c.Kind == "EntityAttribute" && c.Name == name) is not { } attribute) return;
        var before = attribute.Key.Length > 0 && was != null ? was.Children.FirstOrDefault(c => c.Kind == "EntityAttribute" && c.Key == attribute.Key) : null;
        // A kept attribute without the module (the static checks) is left as written: the apply judges it.
        var judged = attribute.Key.Length == 0 || before != null;
        if (judged && attribute.Props.GetValueOrDefault("IsMandatory") != "True"
            && (before == null || before.Props.GetValueOrDefault("IsMandatory") == "True")) {
            attribute.Props["IsMandatory"] = "True";
            result.Notes.Add(new("DDL_IDENTIFIER_REQUIRED", $"line {attribute.Line}: {entity.Name}.{attribute.Name} is the identifier of {entity.Name}, a primary key: "
                + (before == null ? "required, as the platform makes every identifier" : "kept required, as the module has it") + " (the text left out 'required')"));
        }
        if (entity.Kind == "StaticEntity" && judged && attribute.Props.GetValueOrDefault("IsAutoNumber") is "Yes" or "True"
            && before?.Props.GetValueOrDefault("IsAutoNumber") is not ("Yes" or "True")) {
            attribute.Props.Remove("IsAutoNumber");
            result.Notes.Add(new("DDL_STATIC_ID_NOT_AUTO", $"line {attribute.Line}: {entity.Name}.{attribute.Name} is a static entity's identifier, never AutoNumber "
                + "(the spec's rule; the ODC Studio refuses 'StaticEntity Auto Number'): 'auto' left out, each record has its own value"));
        }
    }

    // ---- the label and order attributes of a kept static entity --------------------------------------------------------------
    // A kept statement written from memory leaves out the attribute the entity orders or labels its records by (Order, Label,
    // or the one `order X` / `label X` names in the module). Left out of a kept statement, an attribute is deleted, and with it
    // every record's value of it and the order (or the text) of every list and combo of the entity. Never in silence: when the
    // module's records have values of it, refused once, with its line as the module has it as the patch (it keeps the
    // attribute and its values); deleting it is writing `order none` / `label none` in the statement. Without values it is
    // deleted with a note. A renamed attribute (its key kept) or a new one taking the name is not left out.
    private static void LinkedLeftOut(DdlElement entity, DdlElement was, string? text, string? moduleText, Result result)
    {
        var found = new List<(int Line, string Code, string Message, string Fix, string? Read, DdlElement? After)>();
        foreach (var (property, word, fallback) in new[] { ("LabelAttribute", "label", "Label"), ("OrderByAttribute", "order", "Order") }) {
            if (entity.Props.ContainsKey(property)) continue;   // the statement says it: `order X`, or `order none` to delete
            var linkedName = was.Props.TryGetValue(property, out var named) ? named : fallback;
            if (linkedName == null) continue;
            if (was.Children.FirstOrDefault(c => c.Kind == "EntityAttribute" && c.Name == linkedName) is not { Key.Length: > 0 } linked) continue;
            if (entity.Children.Any(c => c.Kind == "EntityAttribute" && (c.Key == linked.Key || c.Key.Length == 0 && c.Name == linked.Name))) continue;
            var valued = was.Children.Where(IsRecord).Count(r => r.Values.Any(v => v.Attribute == linked.Name && v.Value.Trim() is { Length: > 0 } value && value != "\"\""));
            if (valued == 0) {
                result.Notes.Add(new("DDL_STATIC_LINK_DROPPED", $"line {entity.Line}: static entity {entity.Name}: {linked.Name}, its {word} attribute, is left out of the statement: "
                    + $"deleted with its {word} link (no record has a value of it)"));
                continue;
            }
            var line = AttributeLine(moduleText, linked.Line);
            found.Add((entity.Line, "DDL_STATIC_ATTRIBUTE_LEFT_OUT",
                $"static entity {DdlRules.Name(entity.Name)}: {DdlRules.Name(linked.Name)} is its {word} attribute and {valued} record(s) have a value of it; "
                + $"the statement leaves it out, which deletes the attribute, those values and the {word} of every list and combo of {entity.Name}",
                $"keep it: write its line as the module has it ({line?.Split('\n')[^1].Trim() ?? DdlRules.Name(linked.Name) + " ... -- @" + linked.Key}; the patch), the records keep their values; "
                + $"or, to delete it with its values, write `{word} none` after the entity's name",
                line, Before(was, linked, entity)));
        }
        if (found.Count == 0) return;
        // One patch for the statement: every left-out line back in its place (a line not read leaves no patch).
        var corrected = found.All(f => f.Read != null) ? WithAttributes(text, entity, found.Select(f => (f.Read!, f.After)).ToList()) : null;
        foreach (var f in found) result.Problems.Add(new DdlProblem(f.Line, f.Code, f.Message, f.Fix, corrected));
    }

    // The line of an element in the module's text, as read, with the description lines (///) above it.
    private static string? AttributeLine(string? text, int line)
    {
        if (string.IsNullOrEmpty(text)) return null;
        var lines = text.Replace("\r\n", "\n").Split('\n');
        if (line < 1 || line > lines.Length || !lines[line - 1].Contains("-- @", StringComparison.Ordinal)) return null;
        var first = line - 1;
        while (first > 0 && lines[first - 1].TrimStart().StartsWith("///", StringComparison.Ordinal)) first--;
        return string.Join('\n', lines[first..line]);
    }

    // The statement's attribute the left-out one followed in the module (kept by key), or null: it was the first one, or the
    // one before it is not in the statement (then it goes last).
    private static DdlElement? Before(DdlElement was, DdlElement linked, DdlElement entity)
    {
        var module = was.Children.Where(c => c.Kind == "EntityAttribute").ToList();
        for (var i = module.IndexOf(linked) - 1; i >= 0; i--)
            if (entity.Children.FirstOrDefault(c => c.Kind == "EntityAttribute" && c.Key.Length > 0 && c.Key == module[i].Key) is { } kept) return kept;
        return module.IndexOf(linked) == 0 ? entity : null;
    }

    // The edit with each left-out attribute's line (as read) back in its place in the statement (after the attribute it
    // followed in the module; first; or last), the commas of the list kept right: the certain fix of every problem of the
    // statement at once (the corrected text of the refusal). Null when the statement is not written one attribute per line.
    private static string? WithAttributes(string? text, DdlElement entity, IReadOnlyList<(string Line, DdlElement? After)> missing)
    {
        if (string.IsNullOrEmpty(text) || missing.Count == 0) return null;
        var lines = text.Replace("\r\n", "\n").Split('\n').ToList();
        var attributes = entity.Children.Where(c => c.Kind == "EntityAttribute").Select(c => c.Line).ToList();
        if (attributes.Count == 0) return null;
        var first = attributes.Min(); var last = attributes.Max();
        if (first <= entity.Line || last >= lines.Count || attributes.Distinct().Count() != attributes.Count
            || !lines[last].TrimStart().StartsWith(')') || !lines[entity.Line - 1].TrimEnd().Split(" -- @")[0].TrimEnd().EndsWith('(')) return null;
        static (string Code, string Comment) Split(string l) {
            var at = l.LastIndexOf(" -- @", StringComparison.Ordinal);
            return at < 0 ? (l.TrimEnd(), "") : (l[..at].TrimEnd(), l[at..]);
        }
        var indent = lines[first - 1][..(lines[first - 1].Length - lines[first - 1].TrimStart().Length)];
        // Inserted from the bottom up, so the lines above keep their numbers; the ones after the same line keep the module's order.
        var inserts = missing.Select((m, i) => (At: m.After == entity ? entity.Line : m.After?.Line ?? last, Order: i, m.Line)).OrderByDescending(x => x.At).ThenByDescending(x => x.Order);
        foreach (var (at, _, read) in inserts) {
            var part = read.Split('\n');
            var (added, comment) = Split(part[^1]);
            lines.InsertRange(at, part[..^1].Select(d => indent + d.Trim()).Append(indent + added.Trim().TrimEnd(',') + comment));
        }
        // The list's commas: after every attribute but the last (descriptions and comments aside).
        var close = lines.FindIndex(entity.Line, l => l.TrimStart().StartsWith(')'));
        var block = Enumerable.Range(entity.Line, close - entity.Line)
            .Where(i => lines[i].Trim().Length > 0 && !lines[i].TrimStart().StartsWith("--") && !lines[i].TrimStart().StartsWith("///")).ToList();
        foreach (var i in block) {
            var (code, comment) = Split(lines[i]);
            code = code.TrimEnd(',');
            lines[i] = (i == block[^1] ? code : code + ",") + comment;
        }
        return string.Join('\n', lines);
    }

    // ---- the records of a static entity --------------------------------------------------------------------------------------

    private static void Records(DdlElement entity, DdlElement? was, bool withModule, Result result)
    {
        if (!entity.HasValues) return;
        // A kept statement without the module (the static checks): the values its records keep are not known here.
        if (entity.Key.Length > 0 && was == null) return;
        var attributes = entity.Children.Where(c => c.Kind == "EntityAttribute").ToList();
        var named = attributes.GroupBy(a => a.Name, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        DdlElement? Named(string? name) => name != null && named.TryGetValue(name, out var a) ? a : null;
        var context = new DdlParsedContext(entity);
        var roles = new Dictionary<DdlElement, string>(ReferenceEqualityComparer.Instance);
        if (Named(entity.Props.GetValueOrDefault("Identifier")) is { } id && Integer(id) && id.Props.GetValueOrDefault("IsAutoNumber") is not ("Yes" or "True")) roles[id] = "identifier";
        if (Named(context.Value("LabelAttribute")) is { } label && Text(label)) roles.TryAdd(label, "label");
        if (Named(context.Value("OrderByAttribute")) is { } order && Integer(order)) roles.TryAdd(order, "order");
        // An AutoNumber identifier (O11) numbers its records itself: they have no value of it.
        var watched = attributes.Where(a => roles.ContainsKey(a) || a.Props.GetValueOrDefault("IsMandatory") == "True" && a.Props.GetValueOrDefault("IsAutoNumber") is not ("Yes" or "True")).ToList();
        if (watched.Count == 0) return;
        // The module's records of a kept entity, by key, with their values by the edit's attribute names (a renamed attribute
        // keeps its key).
        // (A key or name written twice is the compiler's problem, DDL_KEY_TWICE: the first one counts here.)
        var nameOfKey = attributes.Where(a => a.Key.Length > 0).GroupBy(a => a.Key, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First().Name, StringComparer.Ordinal);
        var wasNames = (was?.Children ?? []).Where(c => c.Kind == "EntityAttribute").GroupBy(c => c.Name, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First().Key, StringComparer.Ordinal);
        var wasRecords = (was?.Children ?? []).Where(IsRecord).Where(r => r.Key.Length > 0).GroupBy(r => r.Key).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        Dictionary<string, string> ValuesOf(DdlElement record)
        {
            var values = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var (attribute, value) in record.Values)
                if (wasNames.TryGetValue(attribute, out var key) && nameOfKey.TryGetValue(key, out var now)) values.TryAdd(now, value);
            return values;
        }
        // Identifier values taken: the text's and, for a kept entity, every record the module has (deleted ones too: an id is
        // never given to another record in the same edit).
        var taken = new HashSet<long>();
        void Take(DdlElement record, string? attribute) {
            if (attribute == null) return;
            foreach (var (name, value) in record.Values) if (name == attribute && long.TryParse(value.Trim(), out var n)) taken.Add(n);
        }
        var identifier = roles.FirstOrDefault(r => r.Value == "identifier").Key;
        var records = entity.Children.Where(IsRecord).ToList();
        foreach (var record in records) Take(record, identifier?.Name);
        if (identifier != null && was != null) {
            var wasIdentifier = identifier.Key.Length > 0 ? was.Children.FirstOrDefault(c => c.Kind == "EntityAttribute" && c.Key == identifier.Key)?.Name : null;
            foreach (var record in wasRecords.Values) Take(record, wasIdentifier);
        }
        // A new entity numbers from 1 (its position when no record gives an id); a kept one after the largest id it has or the
        // text gives: an id the module had (a record deleted earlier, still in the data) is never given to another record.
        long free = was != null && taken.Count > 0 ? taken.Max() + 1 : 1;
        var filled = new List<string>(); var keptValues = new List<string>();
        for (var i = 0; i < records.Count; i++) {
            var record = records[i];
            var before = record.Key.Length > 0 && wasRecords.TryGetValue(record.Key, out var r) ? ValuesOf(r) : null;
            if (record.Key.Length > 0 && before == null && withModule) continue;   // a record of another entity or deleted: the compiler or the merge decides
            foreach (var attribute in watched) {
                if (record.Values.Any(v => v.Attribute == attribute.Name)) continue;
                if (before != null && before.TryGetValue(attribute.Name, out var keep)) {
                    record.Values.Add((attribute.Name, keep));
                    keptValues.Add(record.Name + "." + attribute.Name + " = " + keep);
                    continue;
                }
                // A kept record the module has without this value (an attribute that was never filled): as it is.
                if (before != null && attribute.Key.Length > 0) continue;
                string? value = roles.GetValueOrDefault(attribute) switch {
                    "identifier" => Next(ref free, taken),
                    "label" => Label(record.Name, attribute),
                    "order" => (i + 1).ToString(System.Globalization.CultureInfo.InvariantCulture),
                    _ => attribute.Props.GetValueOrDefault("DefaultValue"),
                };
                if (value == null) {
                    result.Problems.Add(new DdlProblem(record.Line, "DDL_VALUE_REQUIRED",
                        $"record {DdlRules.Name(record.Name)} of static entity {DdlRules.Name(entity.Name)} has no value for {DdlRules.Name(attribute.Name)}, a required attribute with no default",
                        $"write {DdlRules.Name(attribute.Name)} = <value> in the record, or give the attribute a default (it fills every record that leaves it out)"));
                    continue;
                }
                record.Values.Add((attribute.Name, value));
                filled.Add(record.Name + "." + attribute.Name + " = " + value);
            }
        }
        if (filled.Count > 0)
            result.Notes.Add(new("DDL_STATIC_VALUE_FILLED", $"line {entity.Line}: static entity {entity.Name}: {filled.Count} value(s) the records leave out take what the platform fills "
                + "(identifier: the next free integer; label: the record's name; order: its position; a required attribute: its default): " + Sample(filled)));
        if (keptValues.Count > 0)
            result.Notes.Add(new("DDL_STATIC_VALUE_KEPT", $"line {entity.Line}: static entity {entity.Name}: {keptValues.Count} value(s) the records leave out keep what the module has "
                + "(an identifier, label, order or required value is never cleared): " + Sample(keptValues)));
    }

    private static string Next(ref long free, HashSet<long> taken)
    {
        while (taken.Contains(free)) free++;
        taken.Add(free);
        return free.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }

    // The record's name as a text literal, within the attribute's length.
    private static string Label(string name, DdlElement attribute)
    {
        var text = int.TryParse(attribute.Props.GetValueOrDefault("Length"), out var length) && length > 0 && name.Length > length ? name[..length] : name;
        return "\"" + text.Replace("\"", "\"\"") + "\"";
    }

    private static string Sample(List<string> items) => string.Join(", ", items.Take(6)) + (items.Count > 6 ? ", ... (" + items.Count + ")" : "");

    private static bool Integer(DdlElement attribute) => attribute.Props.GetValueOrDefault("DataType") is "Integer" or "Long Integer";
    private static bool Text(DdlElement attribute) => attribute.Props.GetValueOrDefault("DataType") is null or "Text";
    private static bool IsRecord(DdlElement element) => element.Kind is "Record" or "StaticEntityRecord";

    // ---- indexes of a static entity ------------------------------------------------------------------------------------------

    private static void Indexes(DdlElement entity, DdlElement? was, string? text, Result result)
    {
        foreach (var index in entity.Children.Where(c => c.Kind == "EntityIndex").ToList()) {
            var attributes = entity.Children.Where(c => c.Kind == "EntityAttribute").Select(c => c.Name).ToHashSet(StringComparer.Ordinal);
            if (index.Columns.FirstOrDefault(c => !attributes.Contains(c)) is { } unknown) {
                result.Problems.Add(new DdlProblem(index.Line, "DDL_NAME_UNKNOWN", $"index {DdlRules.Name(index.Name)}: column {DdlRules.Name(unknown)} is not an attribute of static entity {DdlRules.Name(entity.Name)}",
                    "attributes of " + entity.Name + ": " + string.Join(", ", attributes)));
                continue;
            }
            var unique = index.Props.GetValueOrDefault("Unique") == "True";
            // The records the uniqueness is judged on: the statement's list, or the module's when the statement has none.
            var records = (entity.HasValues ? entity.Children : was?.Children ?? []).Where(IsRecord).ToList();
            var judged = unique && (entity.HasValues || was != null);
            if (judged) {
                var seen = new Dictionary<string, string>(StringComparer.Ordinal);
                var repeats = new List<string>();
                foreach (var record in records) {
                    var tuple = string.Join(", ", index.Columns.Select(c => c + " = " + (record.Values.FirstOrDefault(v => v.Attribute == c).Value ?? "(none)")));
                    if (seen.TryGetValue(tuple, out var first)) repeats.Add(first + " and " + record.Name + " (" + tuple + ")");
                    else seen[tuple] = record.Name;
                }
                if (repeats.Count > 0) {
                    result.Problems.Add(new DdlProblem(index.Line, "DDL_STATIC_INDEX_DUPLICATE",
                        $"unique index {DdlRules.Name(index.Name)} on static entity {DdlRules.Name(entity.Name)}: a static entity takes no index, and its records repeat what the index makes unique: " + string.Join("; ", repeats.Take(6)),
                        "give each record its own value, or write the index without unique (the patch; it is left out either way: a static entity's records are fixed in the module)",
                        WithoutUnique(text, index.Line)));
                    continue;
                }
            }
            entity.Children.Remove(index);
            result.Notes.Add(new("DDL_STATIC_INDEX_DROPPED", $"line {index.Line}: index {index.Name} left out: a static entity takes no index (its records are fixed in the module)"
                + (judged ? "; the records' values of (" + string.Join(", ", index.Columns) + ") are unique, as it asks" : "")));
        }
    }

    // The text with the index of that line written without unique: the certain fix (the corrected text of the refusal).
    private static string? WithoutUnique(string? text, int line)
    {
        if (string.IsNullOrEmpty(text)) return null;
        var lines = text.Replace("\r\n", "\n").Split('\n');
        if (line < 1 || line > lines.Length || !lines[line - 1].StartsWith("create unique index ", StringComparison.Ordinal)) return null;
        lines[line - 1] = "create index " + lines[line - 1]["create unique index ".Length..];
        return string.Join('\n', lines);
    }
}
