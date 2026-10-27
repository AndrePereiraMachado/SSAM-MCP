using System.Text.RegularExpressions;

namespace Anvil.Reading;

// The synthetic edits of the LG2 battery (PLANO.md section 8): from the canonical model of a real action, the model as a
// person would edit its text, one kind of edit at a time. Each edit keeps every element it does not touch (same key); a new
// element has the key "new<n>" (printed as its id, FlowPrinter fixedIds). The same action and seed always give the same
// edits. Kinds: expression (a value wrapped in parentheses), call (a call inserted after a node), remove (a node removed,
// its predecessors joined to its next), branch (a new If before a node, its true branch to a new End), rename (a local
// renamed and every expression that names it), swap (two nodes in a row swapped). Asked by name only (not in Kinds): map,
// a record mapping written new (Map, the O11 mapping battery, which FlowBattery follows with a remap of it); noderename, an
// input of a SQL or JavaScript node renamed with the code that names it (@Name, $parameters.Name); mapedit, a field value of a
// mapping the action has put in parentheses (an existing mapping edited by its text, both lanes).
public static class FlowEdits
{
    public static readonly string[] Kinds = ["expression", "call", "remove", "branch", "rename", "swap"];
    public static readonly string[] ByName = ["map", "noderename", "mapedit"];

    public sealed record Edit(string Kind, string What, FlowItem Model);

    // One edit of this kind on the action as it is now (null when the action has no place for it). calls: Execute nodes
    // of the module by flow kind (true: client), the call inserted when the action itself calls nothing.
    public static Edit? Make(FlowItem action, string kind, int seed, IReadOnlyDictionary<bool, List<FlowItem>>? calls = null)
    {
        var random = new Random(seed);
        var model = action.Clone();
        var what = kind switch {
            "expression" => Expression(model, random),
            "call" => Call(model, random, calls),
            "remove" => Remove(model, random),
            "branch" => Branch(model, random),
            "rename" => Rename(model, random),
            "swap" => Swap(model, random),
            "noderename" => NodeRename(model, random),
            "mapedit" => MapEdit(model, random),
            _ => throw new ArgumentException("edit kinds: " + string.Join(", ", Kinds.Concat(ByName)))
        };
        return what == null ? null : new(kind, what, model);
    }

    // ---- map: a record mapping written new (the O11 mapping battery) ---------------------------------------------------

    // What a map edit needs to know of the module (FlowBattery reads it from the model): the record types by the name the
    // text gives them (structures and entities, a name two of them share left out) with their attributes and the text of
    // each attribute's type, a call of (System).ListAppendAll per kind of flow (true: client) to copy, and the mandatory
    // attributes of each record type (a mapping that leaves one empty is refused: the Verify would).
    public sealed record MapTypes(IReadOnlyDictionary<string, IReadOnlyList<(string Name, string Type)>> Records, IReadOnlyDictionary<bool, FlowItem> AppendAll,
        IReadOnlyDictionary<string, IReadOnlySet<string>>? Mandatory = null);

    // The value that fills a mandatory attribute of a type when the source has nothing of that type: its empty value.
    private static string? Empty(string type) => type switch {
        _ when type.EndsWith(" Identifier", StringComparison.Ordinal) => "NullIdentifier()",
        "Text" or "Email" or "Phone Number" or "Long Text" => "\"\"",
        "Integer" or "Long Integer" or "Decimal" or "Currency" => "0",
        "Boolean" => "False",
        "Date" => "NullDate()",
        "Time" => "NullTime()",
        "Date Time" => "#1900-01-01 00:00:00#",
        _ => null };

    // A mapping a person would write into a real action: a new local of another record type (or a list of it) and a new step
    // after a step of the action that fills it from a record or list the action has, mapping up to three attributes of the
    // same type (the value relative to the source record or item: "Code", or "Order.Code" for the record of a one-source
    // aggregate). Two forms: "assign New = Source mapTo { ... }" (record to record) and "(System).ListAppendAll(List=New,
    // SourceList=Source mapTo { ... })" (list to list, from a list parameter or local, or from an aggregate's List, the
    // step then right after the aggregate). Every mandatory attribute of the target is mapped too (from an attribute of the
    // same type the source has, else its empty value: NullIdentifier() for an Id), those first. The new local and node take the
    // key "new1"/"new2". Null when the action has no source a target type can map from. client: the action is a client flow
    // (its ListAppendAll is the client one). Answers the edit with the mapping's source and fields, in the order of the
    // target's attributes, as the platform keeps them (a later edit of the battery changes them), and the mandatory ones among
    // them (never dropped by that edit).
    public static (Edit Edit, string Source, IReadOnlyList<(string Field, string Value)> Fields, IReadOnlySet<string> Mandatory)? Map(FlowItem action, int seed, MapTypes types, bool client)
    {
        var random = new Random(seed);
        var model = action.Clone();
        static bool Simple(string type, MapTypes types) => type.Length > 0 && !type.EndsWith(" List", StringComparison.Ordinal) && !types.Records.ContainsKey(type)
            && !type.StartsWith("Record", StringComparison.Ordinal) && !type.Contains('{');
        // Sources: (expression, record type name, prefix of a value, list?, the node the step goes after or null).
        var sources = new List<(string Expr, string Type, string Prefix, bool List, FlowItem? After)>();
        foreach (var parameter in model.Items.Where(i => i.Role is "in" or "out" or "local" && FlowSyntax.IsIdentifier(i.Name))) {
            var type = parameter.Prop("DataType") ?? "";
            if (types.Records.ContainsKey(type)) sources.Add((parameter.Name, type, "", false, null));
            else if (type.EndsWith(" List", StringComparison.Ordinal) && types.Records.ContainsKey(type[..^5])) sources.Add((parameter.Name, type[..^5], "", true, null));
        }
        foreach (var aggregate in Nodes(model).Where(n => n.Kind == "AggregateNode" && IsStep(n) && FlowSyntax.IsIdentifier(n.Name))) {
            var from = aggregate.Items.Where(p => p.Role == "source").ToList();
            if (from.Count != 1 || aggregate.Items.Any(p => p.Role is "group" or "agg" or "calc") || !FlowSyntax.IsIdentifier(from[0].Name)) continue;
            if (from[0].Prop("Source") is { } entity && types.Records.ContainsKey(entity)) sources.Add((aggregate.Name + ".List", entity, from[0].Name + ".", true, aggregate));
        }
        var steps = Nodes(model).Where(IsStep).ToList();
        var options = new List<(string Expr, string Type, string Prefix, bool List, FlowItem After, string Target, List<(string Field, string Value)> Fields, IReadOnlySet<string> Mandatory)>();
        foreach (var source in sources) {
            if (source.List && !types.AppendAll.ContainsKey(client)) continue;
            var after = source.After ?? (steps.Count > 0 ? steps[random.Next(steps.Count)] : null);
            if (after == null) continue;
            var from = types.Records[source.Type].Where(a => Simple(a.Type, types) && FlowSyntax.IsIdentifier(a.Name)).ToList();
            foreach (var (target, attributes) in types.Records.OrderBy(r => r.Key, StringComparer.Ordinal)) {
                if (string.Equals(target, source.Type, StringComparison.OrdinalIgnoreCase)) continue;
                // A target with an attribute of a record type that has mandatory attributes of its own (a view with its entity)
                // would need those filled too (the conversion maps them as Attribute.Field): not a target here.
                if (attributes.Any(a => types.Records.ContainsKey(a.Type) && (types.Mandatory?.GetValueOrDefault(a.Type)?.Count ?? 0) > 0)) continue;
                var fields = new List<(string Field, string Value)>();
                var used = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                // The mandatory attributes first: from an attribute of the same type, else the empty value of the type.
                var mandatory = types.Mandatory?.GetValueOrDefault(target) ?? new HashSet<string>();
                var unfilled = false;
                foreach (var attribute in attributes.Where(a => mandatory.Contains(a.Name))) {
                    var match = Simple(attribute.Type, types) ? from.FirstOrDefault(a => a.Type == attribute.Type && !used.Contains(a.Name)) : default;
                    if (match.Name != null) { used.Add(match.Name); fields.Add((attribute.Name, source.Prefix + match.Name)); }
                    else if (FlowSyntax.IsIdentifier(attribute.Name) && Empty(attribute.Type) is { } empty) fields.Add((attribute.Name, empty));
                    else unfilled = true;
                }
                if (unfilled) continue;
                var fixedCount = fields.Count;
                foreach (var attribute in attributes.Where(a => !mandatory.Contains(a.Name) && Simple(a.Type, types) && FlowSyntax.IsIdentifier(a.Name))) {
                    var match = from.FirstOrDefault(a => a.Type == attribute.Type && !used.Contains(a.Name));
                    if (match.Name == null) continue;
                    used.Add(match.Name);
                    fields.Add((attribute.Name, source.Prefix + match.Name));
                    if (fields.Count == fixedCount + 3) break;
                }
                fields = fields.OrderBy(f => attributes.ToList().FindIndex(a => a.Name == f.Field)).ToList();
                // Each attribute from its namesake is the mapping the Studio makes by itself (no mapping to write): a person
                // who writes one changes a value.
                if (fields.Count > 0 && fields.All(f => f.Value == source.Prefix + f.Field)) fields[0] = (fields[0].Field, "(" + fields[0].Value + ")");
                if (fields.Count > fixedCount) options.Add((source.Expr, source.Type, source.Prefix, source.List, after, target, fields,
                    fields.Select(f => f.Field).Where(mandatory.Contains).ToHashSet(StringComparer.Ordinal)));
            }
        }
        if (options.Count == 0) return null;
        var chosen = options[random.Next(options.Count)];
        var names = new HashSet<string>(model.Items.Where(i => FlowItem.Keyed(i.Role)).Select(i => i.Name), StringComparer.OrdinalIgnoreCase);
        string Fresh(string stem) { var name = stem; for (var n = 2; names.Contains(name); n++) name = stem + n; names.Add(name); return name; }
        var local = new FlowItem("local", "LocalVariable", "new1", Fresh(chosen.List ? "FlowMappedList" : "FlowMapped"));
        local.Props["DataType"] = new('r', chosen.Target + (chosen.List ? " List" : ""));
        // A new local goes after the action's locals (the text writes them in that order).
        var lastParameter = model.Items.FindLastIndex(i => i.Role is "in" or "out" or "local");
        model.Items.Insert(lastParameter + 1, local);
        var mapping = FlowMapping.Compose(chosen.Expr, chosen.Fields);
        if (mapping == null) return null;
        FlowItem step;
        if (chosen.List) {
            var template = types.AppendAll[client];
            step = new FlowItem("node", "Execute", "new2", Fresh("FlowMap"));
            // The call of the flow's own kind (the template is a call of that kind): no Call= to write.
            step.Props["Action"] = template.Props["Action"];
            var list = new FlowItem("argument", "Argument", "", "List"); list.Props["Value"] = new('e', local.Name);
            var sourceList = new FlowItem("argument", "Argument", "", "SourceList"); sourceList.Props["Value"] = new('e', mapping);
            step.Items.Add(list); step.Items.Add(sourceList);
        } else {
            step = new FlowItem("node", "AssignNode", "new2");
            var assignment = new FlowItem("assignment", "Assignment");
            assignment.Props["Variable"] = new('e', local.Name); assignment.Props["Value"] = new('e', mapping);
            step.Items.Add(assignment);
        }
        var after2 = model.Items.First(i => i.Key == chosen.After.Key);
        step.Edges["Target"] = after2.Edges["Target"];
        after2.Edges["Target"] = step.Key;
        model.Items.Add(step);
        return (new("map", (chosen.List ? "list " : "record ") + chosen.Expr + " (" + chosen.Type + ") -> " + chosen.Target + " after " + after2.Kind + " " + after2.Name, model),
            chosen.Expr, chosen.Fields, chosen.Mandatory);
    }

    private static List<FlowItem> Nodes(FlowItem action) => action.Items.Where(i => i.Role == "node" && !i.Opaque).ToList();
    private static T? Pick<T>(List<T> list, Random random) where T : class => list.Count == 0 ? null : list[random.Next(list.Count)];

    // A node that only goes on to its Target (no branch, no end): where a step can be inserted, removed or swapped.
    private static readonly HashSet<string> Steps = new(StringComparer.Ordinal) {
        "AssignNode", "Execute", "AggregateNode", "SQLNode", "JavaScriptNode", "JSONSerializeNode", "JSONDeserializeNode", "MessageNode",
        "RefreshDataNode", "TriggerNode" };
    private static bool IsStep(FlowItem node) => Steps.Contains(node.Kind) && node.Edges.Count == 1 && node.Edges.TryGetValue("Target", out var to) && to.Length > 0;

    private static IEnumerable<(FlowItem Owner, string Edge)> Into(FlowItem action, string key)
    {
        foreach (var node in action.Items.Where(i => i.Role == "node")) {
            foreach (var (edge, target) in node.Edges.ToList()) if (target == key && edge != "Attached") yield return (node, edge);
            foreach (var part in node.Items.Where(p => p.Role == "case")) if (part.Edges.GetValueOrDefault("Target") == key) yield return (part, "Target");
        }
    }

    private static string? Expression(FlowItem action, Random random)
    {
        var slots = new List<(FlowItem Owner, string Property, string Where)>();
        // An ODC mapping (Source mapTo { Field: Value }) or record literal ({ Field: Value }) is the whole value of an assignment
        // or argument, not an expression a person wraps in parentheses (the platform's parser reads neither inside one).
        static bool Wrappable(FlowValue value) => value.Type == 'e' && value.Text.Length > 0 && !value.Text.Contains(" mapTo {", StringComparison.Ordinal)
            && FlowMapping.SplitRecord(value.Text) == null;
        foreach (var node in Nodes(action)) {
            foreach (var (name, value) in node.Props) if (Wrappable(value)) slots.Add((node, name, node.Kind + "." + name));
            foreach (var part in node.Items.Where(p => p.Role is "assignment" or "argument" or "filter" or "case"))
                foreach (var (name, value) in part.Props) if (Wrappable(value)) slots.Add((part, name, node.Kind + "/" + part.Role + "." + name));
        }
        if (slots.Count == 0) return null;
        var (owner, property, where) = slots[random.Next(slots.Count)];
        owner.Props[property] = new('e', "(" + owner.Props[property].Text + ")");
        return where;
    }

    private static string? Call(FlowItem action, Random random, IReadOnlyDictionary<bool, List<FlowItem>>? calls)
    {
        var after = Pick(Nodes(action).Where(IsStep).ToList(), random);
        if (after == null) return null;
        // A call this action makes, else one of the module's flows of the same kind.
        var template = Pick(Nodes(action).Where(n => n.Kind == "Execute").ToList(), random)
            ?? (calls != null && calls.TryGetValue(action.Kind is "ClientAction" or "ScreenAction", out var known) ? Pick(known, random) : null);
        if (template == null) return null;
        var names = new HashSet<string>(action.Items.Where(i => i.Role == "node").Select(i => i.Name), StringComparer.OrdinalIgnoreCase);
        var name = "FlowCall";
        for (var n = 2; names.Contains(name); n++) name = "FlowCall" + n;
        var call = new FlowItem("node", "Execute", "new1", name);
        call.Props["Action"] = template.Props["Action"];
        // The line copied whole: a callee whose name two actions share carries its kind of call (@{Call=Client|Server}).
        if (template.Props.TryGetValue(FlowRules.CallProperty, out var kindOfCall)) call.Props[FlowRules.CallProperty] = kindOfCall;
        foreach (var argument in template.Items.Where(i => i.Role == "argument")) call.Items.Add(argument.Clone());
        call.Edges["Target"] = after.Edges["Target"];
        after.Edges["Target"] = call.Key;
        action.Items.Add(call);
        return "after " + after.Kind + " " + after.Name + ": " + call.Prop("Action");
    }

    private static string? Remove(FlowItem action, Random random)
    {
        // A step whose name no other node's text names (removing what later steps read would leave them naming nothing).
        var texts = string.Join("\n", Nodes(action).SelectMany(n => n.Props.Values.Concat(n.Items.SelectMany(p => p.Props.Values))).Select(v => v.Text));
        // Not the only step of a loop or branch: its predecessor would then go to itself.
        bool Feeds(FlowItem from, FlowItem to) => from.Edges.Values.Contains(to.Key) || from.Items.Any(p => p.Role == "case" && p.Edges.GetValueOrDefault("Target") == to.Key);
        bool Alone(FlowItem n) => action.Items.Any(other => other.Role == "node" && other.Key == n.Edges["Target"] && Feeds(other, n))
            // ...nor the only step of a branch whose other branch goes where it goes (an If's or a Switch's branches would meet).
            || action.Items.Any(other => other.Kind is "IfNode" or "SwitchNode" && Feeds(other, n)
                && (other.Edges.Values.Contains(n.Edges["Target"]) || other.Items.Any(p => p.Role == "case" && p.Edges.GetValueOrDefault("Target") == n.Edges["Target"])));
        var node = Pick(Nodes(action).Where(n => IsStep(n) && !Alone(n) && (n.Name.Length == 0 || !Regex.IsMatch(texts, @"(?<![\w.])" + Regex.Escape(n.Name) + @"\b"))).ToList(), random);
        if (node == null) return null;
        var next = node.Edges["Target"];
        foreach (var (owner, edge) in Into(action, node.Key).ToList()) owner.Edges[edge] = next;
        foreach (var comment in action.Items.Where(i => i.Role == "node" && i.Edges.GetValueOrDefault("Attached") == node.Key)) comment.Edges.Remove("Attached");
        action.Items.Remove(node);
        return node.Kind + " " + node.Name;
    }

    private static string? Branch(FlowItem action, Random random)
    {
        var before = Pick(Nodes(action).Where(IsStep).ToList(), random);
        if (before == null) return null;
        var decision = new FlowItem("node", "IfNode", "new1");
        decision.Props["Condition"] = new('e', "False");
        decision.Props["Label"] = new('t', "Flow branch?");
        var end = new FlowItem("node", "EndNode", "new2");
        decision.Edges["TrueTarget"] = end.Key;
        decision.Edges["FalseTarget"] = before.Edges["Target"];
        before.Edges["Target"] = decision.Key;
        action.Items.Add(decision); action.Items.Add(end);
        return "after " + before.Kind + " " + before.Name;
    }

    private static readonly Regex Literal = new("\"(?:[^\"]|\"\")*\"", RegexOptions.CultureInvariant);

    private static string? Rename(FlowItem action, Random random)
    {
        // A local whose name is no other name the action uses (its own type, a source, a node, a callee): what a rename
        // rewrites is then exactly what names the local.
        var used = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        void Names(FlowItem item)
        {
            foreach (var value in item.Props.Values.Where(v => v.Type == 'r')) foreach (var part in value.Text.Split('.', ' ')) used.Add(part);
            if (item.Role is "source" or "agg" or "calc" or "group" or "node" or "argument") used.Add(item.Name);
            foreach (var child in item.Items) Names(child);
        }
        foreach (var item in action.Items) Names(item);
        var local = Pick(action.Items.Where(i => i.Role == "local" && FlowSyntax.IsIdentifier(i.Name) && !used.Contains(i.Name)).ToList(), random);
        if (local == null) return null;
        var names = new HashSet<string>(action.Items.Where(i => FlowItem.Keyed(i.Role)).Select(i => i.Name), StringComparer.OrdinalIgnoreCase);
        var name = local.Name + "Renamed";
        for (var n = 2; names.Contains(name); n++) name = local.Name + "Renamed" + n;
        var old = local.Name;
        local.Name = name;
        void Visit(FlowItem item)
        {
            foreach (var (property, value) in item.Props.ToList()) if (value.Type == 'e') item.Props[property] = new('e', Renamed(value.Text, old, name));
            foreach (var child in item.Items) Visit(child);
        }
        foreach (var item in action.Items) Visit(item);
        return old + " -> " + name;
    }

    // An expression with every name `from` (outside text literals, after no dot: an attribute of the same name is another,
    // any case: OutSystems names have none) written `to`: what the rename verb makes of an expression that names a
    // parameter or local (FlowDiff writes no value the rename already rewrites).
    public static string Renamed(string text, string from, string to)
    {
        if (text.IndexOf(from, StringComparison.OrdinalIgnoreCase) < 0) return text;
        var word = new Regex(@"(?<![\w.])" + Regex.Escape(from) + @"(?!\w)", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
        return string.Concat(Pieces(text).Select(p => p.Literal ? p.Text : word.Replace(p.Text, to.Replace("$", "$$"))));
    }

    // Renamed, but never a field name of a mapping or a record literal ("{ Total: ... }", "Source mapTo { Total: ... }": the
    // name before ':' is an attribute of the target, not the parameter or local of that name). What the merge reads an
    // expression of one side in the other side's names with.
    public static string RenamedOutsideFields(string text, string from, string to)
    {
        if (text.IndexOf(from, StringComparison.OrdinalIgnoreCase) < 0) return text;
        var word = new Regex(@"(?<![\w.])" + Regex.Escape(from) + @"(?!\w)(?!\s*:)", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
        return string.Concat(Pieces(text).Select(p => p.Literal ? p.Text : word.Replace(p.Text, to.Replace("$", "$$"))));
    }

    // The rewrite of a node's name in an expression (the platform numbered the node): Renamed (RenamedOutsideFields with
    // outsideFields), never a call. A node is read through its outputs (Node.Out); `Name(` is a call of a function of that
    // name (a built-in, a function of the module or of a reference), which a rename of the node never touches.
    public static string RenamedNode(string text, string from, string to, bool outsideFields = false)
    {
        if (text.IndexOf(from, StringComparison.OrdinalIgnoreCase) < 0) return text;
        var word = new Regex(@"(?<![\w.])" + Regex.Escape(from) + @"(?!\w)(?!\s*\()" + (outsideFields ? @"(?!\s*:)" : ""), RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
        return string.Concat(Pieces(text).Select(p => p.Literal ? p.Text : word.Replace(p.Text, to.Replace("$", "$$"))));
    }

    // An expression with every `prefix` (a dotted path ending in a dot, outside text literals, after no dot, any case) taken
    // off: Source.Current.A.B -> A.B, the value relative to the item (FlowDiff's mapping patch).
    public static string WithoutPrefix(string text, string prefix)
    {
        if (text.IndexOf(prefix, StringComparison.OrdinalIgnoreCase) < 0) return text;
        var word = new Regex(@"(?<![\w.])" + Regex.Escape(prefix), RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
        return string.Concat(Pieces(text).Select(p => p.Literal ? p.Text : word.Replace(p.Text, "")));
    }

    private static IEnumerable<(string Text, bool Literal)> Pieces(string text)
    {
        var at = 0;
        foreach (Match match in Literal.Matches(text)) {
            if (match.Index > at) yield return (text[at..match.Index], false);
            yield return (match.Value, true);
            at = match.Index + match.Length;
        }
        if (at < text.Length) yield return (text[at..], false);
    }

    // An input of a SQL or JavaScript node renamed, and its code with it (SQL @Name, JavaScript $parameters.Name): the rename
    // verb on the node's parameter, its argument kept under the new name.
    private static string? NodeRename(FlowItem action, Random random)
    {
        var options = Nodes(action).Where(n => n.Kind is "SQLNode" or "JavaScriptNode")
            .SelectMany(n => n.Items.Where(p => p.Role == "in" && FlowSyntax.IsIdentifier(p.Name)).Select(p => (Node: n, Parameter: p))).ToList();
        if (options.Count == 0) return null;
        var (node, parameter) = options[random.Next(options.Count)];
        var names = node.Items.Where(p => FlowItem.Keyed(p.Role)).Select(p => p.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var name = parameter.Name + "Renamed";
        for (var n = 2; names.Contains(name); n++) name = parameter.Name + "Renamed" + n;
        var old = parameter.Name;
        var property = node.Kind == "SQLNode" ? "Statement" : "JavaScript";
        var pattern = node.Kind == "SQLNode" ? @"@" + Regex.Escape(old) + @"(?![\w])" : @"\$parameters\." + Regex.Escape(old) + @"(?![\w])";
        var replacement = node.Kind == "SQLNode" ? "@" + name : "$parameters." + name;
        if (node.Props.TryGetValue(property, out var code) && code.Type == 't')
            node.Props[property] = new('t', Regex.Replace(code.Text, pattern, replacement.Replace("$", "$$"), RegexOptions.IgnoreCase | RegexOptions.CultureInvariant));
        parameter.Name = name;
        foreach (var argument in node.Items.Where(p => p.Role == "argument" && p.Name == old)) argument.Name = name;
        return node.Kind + " " + node.Name + ": " + old + " -> " + name;
    }

    // A field value of a mapping the action has (an assignment's or an argument's Value: Source mapTo { Field: value }) put in
    // parentheses, as a person edits it: the mapping written again whole by its text.
    private static string? MapEdit(FlowItem action, Random random)
    {
        var slots = new List<(FlowItem Part, string Source, List<(string Field, string Value)> Fields)>();
        foreach (var node in Nodes(action))
            foreach (var part in node.Items.Where(p => p.Role is "assignment" or "argument"))
                if (part.Prop("Value") is { } value && FlowMapping.Split(value) is { Fields.Count: > 0 } mapping
                    && FlowMapping.Compose(mapping.Source, [(mapping.Fields[0].Field, "(" + mapping.Fields[0].Value + ")"), .. mapping.Fields.Skip(1)]) != null)
                    slots.Add((part, mapping.Source, mapping.Fields));
        if (slots.Count == 0) return null;
        var (target, source, fields) = slots[random.Next(slots.Count)];
        var edited = fields.ToList();
        edited[0] = (edited[0].Field, "(" + edited[0].Value + ")");
        target.Props["Value"] = new('e', FlowMapping.Compose(source, edited)!);
        return target.Role + " " + (target.Prop("Variable") ?? target.Name) + ": " + source + " mapTo { " + edited[0].Field + ": " + edited[0].Value + ", ... }";
    }

    private static string? Swap(FlowItem action, Random random)
    {
        var nodes = Nodes(action).ToDictionary(n => n.Key, StringComparer.Ordinal);
        var pairs = nodes.Values.Where(IsStep).Select(a => (A: a, B: nodes.GetValueOrDefault(a.Edges["Target"])))
            .Where(p => p.B != null && IsStep(p.B) && p.B.Key != p.A.Key && p.B.Edges["Target"] != p.A.Key
                && Into(action, p.B.Key).All(i => i.Owner == p.A)).ToList();
        if (pairs.Count == 0) return null;
        var (a, b) = pairs[random.Next(pairs.Count)];
        var next = b!.Edges["Target"];
        foreach (var (owner, edge) in Into(action, a.Key).ToList()) owner.Edges[edge] = b.Key;
        b.Edges["Target"] = a.Key;
        a.Edges["Target"] = next;
        return a.Kind + " " + a.Name + " <-> " + b.Kind + " " + b.Name;
    }
}
