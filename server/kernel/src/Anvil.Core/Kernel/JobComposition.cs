using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;

namespace Anvil.Core;

/// <summary>
/// Family F5 (composition in one delivery): the order of the ops of one job does not matter for the references among the
/// elements the job itself creates, wherever the kernel can tell them; where it cannot, the job's order stays. A pure
/// function of the ops and of the names the base already has (the same job and base give the same plan), applied by
/// ModelSession.Apply before the first op:
/// <list type="bullet">
/// <item>the ops the kernel reads whole (html documents, html edits, the html page form, logic ops, spec ops, reference ops)
/// say what they declare new and what they reference, from their parsed form only: a call, a type, an owner, a source, a
/// navigation's destination, a block a page uses, a binding. Never a word of a value, a parameter's name, an attribute after
/// a dot or the visible text of a page. A name the base already has never moves anything;</item>
/// <item>every other op (a raw verb, rest, soap, entity-actions, screen, ...) creates or changes what the kernel does not
/// read: it is a barrier, nothing moves across it;</item>
/// <item>between two barriers, an op that declares what an earlier op references whole runs before it (a stable order: the
/// job's where nothing is referenced); ops that reference each other keep the job's order. An op is never moved past
/// another op that writes what it writes or reads, or reads what it writes (a name the base has, the theme): then the job's
/// order stays, whole;</item>
/// <item>a screen an earlier op only navigates to is declared before the first op (its name, flow and inputs) and its
/// document fills it in place (Verbs.ScreenDocument.cs): two screens that navigate to each other build in one job.</item>
/// </list>
/// </summary>
public static class JobComposition
{
    /// <summary>An element an op declares: its kind (screen, block, action, data) and name; Owned: an action of a screen or
    /// block (a screen action, a data action), which the op of its screen makes a shell the logic op fills (H10): never needed.</summary>
    public sealed record Declared(int Op, string Kind, string Name, bool Owned = false);

    /// <summary>An op whose place changed: its index in the job, its position in the job's order and in the plan's, the op it
    /// now runs before when it was moved for it, and the name that op needs of it.</summary>
    public sealed record Move(int Op, int From, int To, int? Before = null, string? Declares = null);

    /// <summary>The plan: the order the ops run in, the roots declared before the first op (op, name), every op whose place
    /// changed, the groups of ops that reference each other (kept in the job's order) and why the job's order was kept whole
    /// (null when it was not).</summary>
    public sealed record Plan(int[] Order, IReadOnlyList<(int Op, string Name)> Roots, IReadOnlyList<Move> Moved, IReadOnlyList<string> Cycles,
        string? Kept = null)
    {
        public bool Changed => Moved.Count > 0 || Roots.Count > 0;
    }

    /// <summary>What an op needs of a name: only the signature of a screen (an event navigates to it), a whole block (a page
    /// uses it), data (a type, a source), or the element whole (an owner, a call, a destination of the page form).</summary>
    public enum Need { Signature, Block, Data, Any }

    private static readonly Regex Name = new(@"^[A-Za-z_][A-Za-z0-9_]*$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex TypeWord = new(@"[A-Za-z_][A-Za-z0-9_]*", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly HashSet<string> TypeWords = new(StringComparer.OrdinalIgnoreCase) { "List", "Identifier", "Record", "Of" };

    /// <summary>The plan of <paramref name="ops"/>, run in <paramref name="initial"/> order otherwise (ModelSession.ArgumentOrder);
    /// <paramref name="exists"/>: whether the base already has an element of that name.</summary>
    public static Plan Compose(JsonArray ops, IReadOnlyList<int> initial, Func<string, bool> exists)
    {
        var identity = new Plan([.. initial], [], [], []);
        var kinds = new string[ops.Count];
        for (var i = 0; i < ops.Count; i++) kinds[i] = ops[i] is JsonObject o ? Kind(o) : "barrier";
        var declared = new List<Declared>();
        for (var i = 0; i < ops.Count; i++)
            try { declared.AddRange(Declarations(ops[i] as JsonObject, i)); } catch (Exception) { /* the op's own refusal says why */ }
        // A name declared by one op of the job and absent from the base; a name two ops declare is left to their own refusals.
        var byName = declared.Where(d => !exists(d.Name)).GroupBy(d => d.Name, StringComparer.OrdinalIgnoreCase)
            .Where(g => g.Select(d => d.Op).Distinct().Count() == 1).ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);
        if (byName.Count == 0) return identity;
        // The barriers cut the job: ops move only inside the stretch between two of them.
        var position = new Dictionary<int, int>();
        for (var k = 0; k < initial.Count; k++) position[initial[k]] = k;
        var stretch = new Dictionary<int, int>();
        var current = 0;
        foreach (var i in initial) { if (kinds[i] == "barrier") { current++; stretch[i] = current++; } else stretch[i] = current; }
        var needs = new Dictionary<int, List<(string Name, Need Need)>>();
        for (var i = 0; i < ops.Count; i++)
            if (kinds[i] != "barrier" && ops[i] is JsonObject op)
                try { needs[i] = Needs(op).ToList(); } catch (Exception) { needs[i] = []; }
        var hard = new Dictionary<int, List<(int Provider, string Name)>>();
        var soft = new List<(int Consumer, int Provider, string Name)>();
        foreach (var (i, list) in needs)
            foreach (var (name, need) in list)
            {
                if (!byName.TryGetValue(name, out var d) || d.Op == i || !position.ContainsKey(i) || !position.ContainsKey(d.Op)) continue;
                // An action of a screen or block is never needed whole: the op of its screen makes it a shell (H10).
                if (d.Kind == "action" && d.Owned) continue;
                var ok = need switch
                {
                    Need.Signature => d.Kind == "screen",
                    Need.Block => d.Kind == "block",
                    Need.Data => d.Kind == "data",
                    _ => true,
                };
                if (!ok) continue;
                // A screen an event of a document or an edit navigates to, declared by a document: only its signature.
                if (need == Need.Signature && kinds[d.Op] == "document") { soft.Add((i, d.Op, d.Name)); continue; }
                if (stretch[i] != stretch[d.Op]) continue;
                (hard.TryGetValue(i, out var providers) ? providers : hard[i] = []).Add((d.Op, d.Name));
            }
        var group = Groups(initial, i => hard.TryGetValue(i, out var p) ? p.Select(x => x.Provider) : []);
        var cycles = group.Values.Distinct().Where(g => g.Count > 1)
            .Select(g => "ops " + string.Join(", ", g.OrderBy(i => position[i]).Select(i => "#" + i)) + " reference each other (" + string.Join("; ",
                g.SelectMany(i => (hard.GetValueOrDefault(i) ?? []).Where(p => g.Contains(p.Provider)).Select(p => $"#{i} needs {p.Name} of #{p.Provider}"))) + "): kept in the job's order").ToList();
        var placed = new HashSet<List<int>>(ReferenceEqualityComparer.Instance);
        var order = new List<int>(initial.Count);
        var why = new Dictionary<int, (int Before, string Name)>();
        void Visit(List<int> members)
        {
            if (!placed.Add(members)) return;
            foreach (var member in members.OrderBy(i => position[i]))
                foreach (var (provider, provided) in (hard.GetValueOrDefault(member) ?? []).Where(p => !members.Contains(p.Provider)).OrderBy(p => position[p.Provider]))
                {
                    if (!placed.Contains(group[provider]) && position[provider] > position[member]) why.TryAdd(provider, (member, provided));
                    Visit(group[provider]);
                }
            order.AddRange(members.OrderBy(i => position[i]));
        }
        foreach (var i in initial) Visit(group[i]);
        // Never past another op that writes what the moved op writes or reads, or reads what it writes: the job's order, whole.
        // A name the job declares as a shell first (an action of a screen, H10; a screen a document declares) is no conflict.
        bool Shelled(string name) => byName.TryGetValue(name, out var d) && (d.Kind == "action" && d.Owned || d.Kind == "screen" && kinds[d.Op] == "document");
        var kept = Conflict(ops, order, position, needs, exists, Shelled);
        if (kept != null) order = [.. initial];
        var at = new Dictionary<int, int>();
        for (var k = 0; k < order.Count; k++) at[order[k]] = k;
        // Every op whose place changed: its index, or the ops it runs before (an op moved for a consumer may keep its index).
        var moved = order.Select((op, to) => (op, to)).Where(x => position[x.op] != x.to || kept == null && why.ContainsKey(x.op))
            .Select(x => why.TryGetValue(x.op, out var w) ? new Move(x.op, position[x.op], x.to, w.Before, w.Name) : new Move(x.op, position[x.op], x.to)).ToList();
        // A screen an earlier op navigates to before its document runs: its root is declared before the first op.
        var roots = soft.Where(e => at[e.Consumer] < at[e.Provider]).Select(e => (e.Provider, e.Name)).Distinct().OrderBy(e => e.Provider).ToList();
        return new([.. order], roots, moved, cycles, kept);
    }

    // The first pair of ops the plan swaps where one writes what the other writes or reads, or reads what it writes, read from
    // their parsed form (a name the base has, the theme; a name only the job creates is the reference the move is for); null.
    private static string? Conflict(JsonArray ops, List<int> order, Dictionary<int, int> position, Dictionary<int, List<(string Name, Need Need)>> needs,
        Func<string, bool> exists, Func<string, bool> shelled)
    {
        var writes = new Dictionary<int, HashSet<string>>();
        HashSet<string> Writes(int i) => writes.TryGetValue(i, out var w) ? w : writes[i] = WritesOf(ops[i] as JsonObject, i);
        HashSet<string> Reads(int i) => (needs.GetValueOrDefault(i) ?? []).Select(n => n.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
        for (var x = 0; x < order.Count; x++)
            for (var y = x + 1; y < order.Count; y++)
            {
                int early = order[x], late = order[y];
                if (position[early] < position[late]) continue;
                // `early` was written after `late` and now runs before it.
                var shared = Writes(early).Intersect(Writes(late), StringComparer.OrdinalIgnoreCase)
                    .Concat(Reads(early).Intersect(Writes(late), StringComparer.OrdinalIgnoreCase).Where(n => !shelled(n)))
                    .Concat(Writes(early).Intersect(Reads(late), StringComparer.OrdinalIgnoreCase).Where(n => n == "theme" || exists(n))).FirstOrDefault();
                if (shared != null) return $"op #{early} and op #{late} both write or read {shared}: the job's order is kept";
            }
        return null;
    }

    // What an op writes, from its parsed form: what it declares (new or not: a data text changes an entity the base has, a flow
    // text with @key its action, an edit its screen) and the theme (a document's or edit's style for the theme, a page's CSS).
    private static HashSet<string> WritesOf(JsonObject? op, int index)
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (op == null) return names;
        try { foreach (var d in Declarations(op, index)) names.Add(d.Name); } catch (Exception) { }
        try
        {
            if (op["op"]?.ToString() == "logic" && op["data"] is JsonObject data && data.ContainsKey("flow"))
                foreach (var (text, _, _) in FlowTextForm.Texts(data))
                    if (FlowTextForm.Header(text) is { Name.Length: > 0 } header) names.Add(header.Name);
            var html = op["data"]?["html"] is JsonValue h && h.TryGetValue<string>(out var t) ? t : "";
            switch (Kind(op))
            {
                case "edit":
                    if (op["data"]?["screen"]?.ToString() is { Length: > 0 } screen) names.Add(Last(screen));
                    if (html.Contains("scope=\"theme\"", StringComparison.Ordinal) || html.Contains("<svg", StringComparison.OrdinalIgnoreCase)) names.Add("theme");
                    break;
                case "document":
                    if (html.Contains("scope=\"theme\"", StringComparison.Ordinal) || html.Contains("<svg", StringComparison.OrdinalIgnoreCase)) names.Add("theme");
                    break;
                case "page":
                    names.Add("theme");
                    if (op["data"]?["screen"]?.ToString() is { Length: > 0 } page) names.Add(Last(page));
                    break;
            }
        }
        catch (Exception) { }
        return names;
    }

    // The kind of an op for the composition: document (an html document, a new screen or block), edit (an html edit of a
    // reading), page (the html page form), logic, data (spec), reference; any other is a barrier.
    private static string Kind(JsonObject op) => op["op"]?.ToString() switch
    {
        "html" when op["parent"] != null => "barrier",
        "html" when ScreenDocument.IsDocumentOp(op) => "document",
        "html" when ScreenHtmlEdit.IsEdit(op) => "edit",
        "html" when op["data"] is JsonObject data && data["screen"] is JsonValue && data["components"] == null => "page",
        "logic" => "logic",
        "spec" => "data",
        "reference" => "reference",
        _ => "barrier",
    };

    /// <summary>The elements an op declares new (before the base says whether it already has them).</summary>
    public static IEnumerable<Declared> Declarations(JsonObject? op, int index)
    {
        if (op == null) yield break;
        switch (Kind(op))
        {
            case "reference":
                // A reference op brings elements of a producer: what a later op of the job names of them runs after it.
                foreach (var element in (op["elements"] as JsonArray ?? []).OfType<JsonValue>())
                    if (element.TryGetValue<string>(out var typed) && typed.Split(':', 2) is [var type, var referenced] && referenced.Length > 0)
                        yield return new(index, type.Contains("Screen", StringComparison.Ordinal) ? "screen" : type.Contains("Block", StringComparison.Ordinal) ? "block"
                            : type.Contains("Action", StringComparison.Ordinal) ? "action" : "data", referenced);
                break;
            case "document":
                if (Root(op["data"]!["html"]!.GetValue<string>()) is { } root && root.Get("name") is { Length: > 0 } name)
                    yield return new(index, root.Tag == "block" ? "block" : "screen", name);
                break;
            case "page":
                if (op["data"]?["screen"]?.ToString() is { Length: > 0 } page && Name.IsMatch(page)) yield return new(index, "screen", page);
                break;
            case "logic":
                if (op["data"] is not JsonObject data) break;
                foreach (var action in (data["actions"] as JsonArray ?? []).OfType<JsonObject>())
                    if (action["name"]?.ToString() is { Length: > 0 } actionName)
                        yield return new(index, "action", actionName, action["owner"] != null || action["kind"]?.ToString() is "screen" or "data" or "preparation");
                if (data.ContainsKey("flow"))
                    foreach (var (text, _, _) in FlowTextForm.Texts(data))
                        if (FlowTextForm.Header(text) is { Key.Length: 0, Name.Length: > 0 } header)
                            yield return new(index, "action", header.Name, header.Owner.Length > 0);
                break;
            case "data":
                if (op["data"] is not JsonObject spec) break;
                if (spec["ddl"] is JsonValue ddl && ddl.TryGetValue<string>(out var source))
                    foreach (var element in DdlParser.Parse(source, MessageExpectations.Lane).Elements)
                        if (element.Name.Length > 0) yield return new(index, "data", element.Name);
                foreach (var section in new[] { "entities", "clientEntities", "static", "structures" })
                    foreach (var record in (spec[section] as JsonArray ?? []).OfType<JsonObject>())
                        if (record["name"]?.ToString() is { Length: > 0 } recordName) yield return new(index, "data", recordName);
                break;
        }
    }

    /// <summary>The names an op references, from its parsed form only, each with what it needs of it.</summary>
    public static IEnumerable<(string Name, Need Need)> Needs(JsonObject op)
    {
        var kind = Kind(op);
        var found = new List<(string, Need)>();
        switch (kind)
        {
            case "document" or "edit":
            {
                var text = op["data"]!["html"]!.GetValue<string>();
                foreach (var (element, _) in ScreenHtmlText.Elements(ScreenHtml.Parse(text)))
                {
                    if (element.IsText) continue;
                    // A block the page uses: the whole block (its inputs, events and placeholders).
                    if (element.Tag == "Block" && element.Get("name") is { Length: > 0 } block) found.Add((Last(block), Need.Block));
                    // The type of a variable or an input, the sources of an aggregate.
                    if (element.Tag is "var" or "input" && element.Get("type") is { Length: > 0 } type) found.AddRange(Types(type));
                    if (element.Tag == "aggregate")
                    {
                        foreach (var from in (element.Get("from") ?? "").Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)) found.Add((Last(from), Need.Data));
                        foreach (var join in (element.Get("join") ?? "").Split(';', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
                            if (join.Split(' ', 2)[0] is { Length: > 0 } right) found.Add((Last(right), Need.Data));
                    }
                    if (element.Get("os-Source") is { Length: > 0 } entity) found.Add((Last(entity), Need.Data));
                    // An event's destination: a screen it navigates to needs only its signature (name and inputs).
                    foreach (var (attribute, value) in element.Attributes)
                        if ((attribute.StartsWith("on", StringComparison.Ordinal) || attribute.StartsWith('@')) && !attribute.Contains('.')
                            && ScreenDocument.ParseCall(value, out var target, out _) && target.Length > 0)
                            found.Add((Last(target), Need.Signature));
                }
                // An edit needs the screen it edits.
                if (kind == "edit" && op["data"]?["screen"]?.ToString() is { Length: > 0 } screen) found.Add((Last(screen), Need.Any));
                break;
            }
            case "page":
            {
                var data = op["data"]!.AsObject();
                foreach (var (_, binding) in data["bindings"] as JsonObject ?? [])
                {
                    if (binding is not JsonObject b) continue;
                    if (b["action"]?.ToString() is { Length: > 0 } action) found.Add((Last(action), Need.Any));
                    if (b["destination"]?.ToString() is { Length: > 0 } destination) found.Add((Last(destination), Need.Any));
                }
                foreach (var pageSource in (data["sources"] as JsonArray ?? []).Append(data["source"]).OfType<JsonObject>())
                {
                    if (pageSource["entity"]?.ToString() is { Length: > 0 } entity) found.Add((Last(entity), Need.Data));
                    if (pageSource["action"]?.ToString() is { Length: > 0 } sourceAction) found.Add((Last(sourceAction), Need.Any));
                }
                foreach (var variable in (data["vars"] as JsonArray ?? []).OfType<JsonObject>())
                    if (variable["type"]?.ToString() is { Length: > 0 } type) found.AddRange(Types(type));
                break;
            }
            case "logic":
            {
                var data = op["data"] as JsonObject ?? [];
                foreach (var action in (data["actions"] as JsonArray ?? []).OfType<JsonObject>()) LogicNeeds(action, found);
                if (data.ContainsKey("flow"))
                    foreach (var (text, _, _) in FlowTextForm.Texts(data))
                    {
                        FlowItem item;
                        try { item = ModuleFlow.Read(text); } catch (FormatException) { continue; }
                        if (item.Owner.Length > 0) found.Add((Last(item.Owner), Need.Any));
                        FlowNeeds(item, found);
                    }
                break;
            }
            case "data":
                if (op["data"]?["ddl"] is JsonValue ddl && ddl.TryGetValue<string>(out var source))
                    foreach (var element in DdlParser.Parse(source, MessageExpectations.Lane).All())
                    {
                        if (element.Props.TryGetValue("DataType", out var type) && type is { Length: > 0 }) found.AddRange(Types(type));
                        if (element.References is { Length: > 0 } references) found.Add((Last(references), Need.Data));
                        if (element.Of is { Length: > 0 } of) found.Add((Last(of), Need.Data));
                    }
                break;
        }
        return found;
    }

    // The references of a JSON logic declaration: its owner, the types of its parameters and variables, and what its steps
    // call, read and raise (by the keys the logic op gives them).
    private static void LogicNeeds(JsonNode? node, List<(string, Need)> found)
    {
        switch (node)
        {
            case JsonObject o:
                foreach (var (key, value) in o)
                {
                    var text = value is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
                    if (text != null)
                    {
                        if (key == "type") found.AddRange(Types(text));
                        else if (key is "owner" or "call" or "get" or "create" or "update" or "delete" or "createOrUpdate" or "raise" or "entity" or "action")
                            foreach (var part in text.Split('/')) if (Reference(part) is { } name) found.Add((name, Need.Any));
                    }
                    else LogicNeeds(value, found);
                }
                break;
            case JsonArray a:
                foreach (var item in a) LogicNeeds(item, found);
                break;
        }
    }

    // The references of a flow text: the types of its parameters, locals and node parameters, and every reference value
    // (an action a node calls, a screen it navigates to, a source, an entity or structure, a widget it refreshes).
    private static void FlowNeeds(FlowItem item, List<(string, Need)> found)
    {
        foreach (var (name, value) in item.Props)
        {
            if (name == "DataType") found.AddRange(Types(value.Text));
            else if (value.Type == 'r' && Reference(value.Text) is { } reference) found.Add((reference, Need.Any));
        }
        foreach (var child in item.Items) FlowNeeds(child, found);
    }

    // The element a reference value names: its last name (Producer.Action, Type:Name, Screen/Widget), or null for an expression.
    private static string? Reference(string text)
    {
        var bare = text.Trim();
        if (bare.Contains(':')) bare = bare[(bare.IndexOf(':') + 1)..];
        bare = Last(bare);
        return Name.IsMatch(bare) ? bare : null;
    }

    private static string Last(string text)
    {
        var bare = text.Trim();
        var cut = bare.LastIndexOfAny(['.', '/', ':']);
        return cut >= 0 ? bare[(cut + 1)..] : bare;
    }

    // The records a type names (CatalogRow List, LoanRequest Identifier, Record of A, B): its words but List, Identifier, Record.
    private static IEnumerable<(string, Need)> Types(string type) =>
        TypeWord.Matches(type).Select(m => m.Value).Where(w => !TypeWords.Contains(w)).Select(w => (w, Need.Data));

    // The root element of a document (<screen> or <block>), or null.
    private static ScreenHtml.Node? Root(string html) =>
        ScreenHtml.Parse(html).Children.FirstOrDefault(c => !c.IsText && c.Tag is "screen" or "block");

    /// <summary>The signature of a document's root as a document of its own: the root with its name and flow, and its inputs and
    /// events (what another page binds to), nothing else. Null when the text is no document.</summary>
    public static string? Signature(string html)
    {
        var root = Root(html);
        if (root == null) return null;
        string Attributes(ScreenHtml.Node node, params string[] keep) => string.Concat(node.Attributes.Where(a => keep.Length == 0 || keep.Contains(a.Key))
            .Select(a => " " + a.Key + "=\"" + System.Net.WebUtility.HtmlEncode(a.Value) + "\""));
        var text = new System.Text.StringBuilder("<" + root.Tag + Attributes(root, "name", "flow") + ">\n");
        foreach (var child in root.Children.Where(c => !c.IsText && c.Tag is "input" or "event"))
            text.Append("<" + child.Tag + Attributes(child) + "/>\n");
        return text.Append("</" + root.Tag + ">").ToString();
    }

    // The strongly connected groups of the ops under their needs (Kosaraju): each op with the list of its group.
    private static Dictionary<int, List<int>> Groups(IReadOnlyList<int> nodes, Func<int, IEnumerable<int>> next)
    {
        var finished = new List<int>();
        var seen = new HashSet<int>();
        foreach (var start in nodes)
        {
            if (!seen.Add(start)) continue;
            var stack = new Stack<(int Node, IEnumerator<int> Next)>();
            stack.Push((start, next(start).GetEnumerator()));
            while (stack.Count > 0)
            {
                var (node, it) = stack.Peek();
                if (it.MoveNext()) { if (seen.Add(it.Current)) stack.Push((it.Current, next(it.Current).GetEnumerator())); }
                else { stack.Pop(); finished.Add(node); }
            }
        }
        var back = new Dictionary<int, List<int>>();
        foreach (var node in nodes) foreach (var to in next(node)) (back.TryGetValue(to, out var list) ? list : back[to] = []).Add(node);
        var group = new Dictionary<int, List<int>>();
        for (var k = finished.Count - 1; k >= 0; k--)
        {
            if (group.ContainsKey(finished[k])) continue;
            var members = new List<int>();
            var pending = new Stack<int>(); pending.Push(finished[k]); group[finished[k]] = members;
            while (pending.TryPop(out var node))
            {
                members.Add(node);
                foreach (var from in back.GetValueOrDefault(node) ?? []) if (!group.ContainsKey(from)) { group[from] = members; pending.Push(from); }
            }
        }
        return group;
    }
}
