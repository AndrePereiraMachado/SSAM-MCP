using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Reading;

// One problem of an edited text, refused before anything is written: code, message, the id it names, the fix and the
// patch (the corrected text of the line or block, checked by reading it again under the same rules).
public sealed record FlowProblem(string Code, string Message, string? Id = null, string? Fix = null, string? Patch = null)
{
    // More fields of the refusal (a ready edit, the conflicts of a merge), copied into the problem as they are.
    public JsonObject? Data { get; init; }
    // The whole text with every certain fix of the text applied (FlowDiff.Corrections): it was read again under the same rules
    // and has none of the problems it fixes and no new one. Added: the new action texts the fix needs (a new JavaScript moved
    // into its own client action), checked the same way. Null when the fix is not certain.
    public string? Corrected { get; init; }
    public IReadOnlyList<string>? Added { get; init; }
    // Fields of the problem beyond the common ones (QUERY_IN_LOOP: flow, loop, query, queryKind).
    public JsonObject? Fields { get; init; }
    public JsonObject ToJson() => new() { ["code"] = Code, ["message"] = Message, ["id"] = Id, ["fix"] = Fix, ["patch"] = Patch };
}

// The owner a new screen, block or data action is created under, as the session resolved the header's owner: the reference
// the create takes ("@key") and whether it is a Traditional owner (its screen action is the Web one).
public sealed record FlowOwnerRef(string Ref, bool Web);

// The way back of ssam-flow/1 (stage LG2 of the text plan): from the text a model wrote over the read of one action to the
// raw verb ops that make the action say exactly that text, keeping the key of every element the text kept.
//  - Identity is the id: a line with an id of the read is that element (its key stays); a line without an id, or with an
//    id no read gives (other than the read's own n/p/l pattern), is a new element; an id of the read written on another
//    kind of element is the old element removed and a new one written. Renaming a parameter or local with the same id is
//    the rename verb (it rewrites the expressions that name it); a node's name is set.
//  - Values: a property that changed is a `set` of that property only; a part of a node (assignments, cases, aggregate
//    sources/joins/filters/groups/columns/sorts, SQL outputs) has no identity of its own, so a part group that changed is
//    replaced whole; an argument is set by its parameter's name.
//  - Graph: a connector that changed is a `link`; a removed node is deleted after every connector left it; a new node is
//    created, filled and linked. Start, connectors and positions are never written by the model.
//  - Rules (one refusal with every problem): ids that are not this read's (FLOW_KEY_FOREIGN), an id on another kind of
//    element (FLOW_KEY_ROLE), an id twice (FLOW_KEY_TWICE), a jump to a node the text removed or never wrote
//    (FLOW_JUMP_UNKNOWN), an opaque node changed, moved, removed or written new (FLOW_OPAQUE_TOUCHED), a new For Each
//    that only filters, maps or accumulates into a list (FLOW_FOREACH_LIST_ACTION, T1/T2, with the List action as patch),
//    a value that cannot be left out (FLOW_VALUE_REQUIRED), an existing node renamed onto a name the action already uses
//    (FLOW_NODE_NAME_TAKEN). T3 (a query inside a loop) is QUERY_IN_LOOP, decided on the candidate for every op.
// The ops carry marks for the session that applies them (keys starting with '_', which the verb contract allows):
//   _ref:     the value (or an arg of a create) is the display name of a model element as the reader writes it
//             (FlowExtractor.Named/Callee); the session resolves it to the element ("@key").
//   _execute: a create of an Execute node, whose native type (server or client) follows from the action it calls.
//   _source:  a reference to a source of the same aggregate by its name (joins, MasterSource).
//   _attach:  a comment attached to a node (its connector is replaced).
//   _optional: an argument the platform may have dropped when the action changed (skipped when it is not there).
public sealed partial class FlowDiff
{
    // Every alias of a created element starts with it ($flow<n>.e1: one prefix per text of the job).
    public const string AliasPrefix = "$flow";
    public readonly List<JsonObject> Ops = [];
    public readonly List<FlowProblem> Problems = [];
    // Text id -> alias of the element created for it ($flow.e1...).
    public readonly Dictionary<string, string> Created = new(StringComparer.Ordinal);
    // Kind changed (an id of the read on another kind): the old key and the alias of the new element.
    public readonly List<(string Id, string OldKey, string Alias)> Recreated = [];
    public readonly List<string> Deleted = [];
    public readonly List<(string Element, string From, string To)> Renamed = [];
    // New nodes whose name the action already used: the name the Studio gives the newcomer.
    public readonly List<(string Id, string Asked, string Given)> NodeNames = [];
    // The model the action reads as after the ops: the edited one with model keys for the kept elements and aliases for the
    // new ones (FlowApply replaces the aliases with the keys the creates gave).
    public FlowItem Expected { get; private set; } = new("action", "");
    // The keys of the elements the edit writes (new, changed or relinked): every other key must read back untouched.
    public readonly HashSet<string> Touched = new(StringComparer.Ordinal);
    // Every id of the text (a fresh one included) -> the key of the read it keeps, or the alias of the element created for it.
    public IReadOnlyDictionary<string, string> Mapped => mapped;

    private readonly FlowItem? baseline;
    private readonly IReadOnlyDictionary<string, string> ids;
    private readonly string? baseText;
    private readonly Dictionary<string, FlowItem> baseByKey = new(StringComparer.Ordinal);
    // A keyed element of the base -> its owner item (the action or a node), for node parameters.
    private readonly Dictionary<string, FlowItem> ownerOf = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> idOfKey = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> mapped = new(StringComparer.Ordinal);
    private int aliases;
    private static readonly Regex ReadId = new(@"^[npl][0-9]+$", RegexOptions.CultureInvariant);

    private readonly string prefix;
    // The action's parameters and locals the text renames (from, to): the rename verb rewrites every expression that names
    // them, so a value that only differs by them is not written again.
    private readonly List<(string From, string To)> renames = [];

    private readonly FlowOwnerRef? owner;
    private bool allowScreenJavaScript;

    private FlowDiff(FlowItem? baseline, IReadOnlyDictionary<string, string> ids, string? baseText, string prefix, string? editedText, Func<string, bool>? actionTaken,
        bool allowQueryInLoop, bool correct, IFlowTypes? types, FlowOwnerRef? owner)
    {
        this.baseline = baseline; this.ids = ids; this.baseText = baseText; this.prefix = prefix; this.owner = owner;
        this.editedText = editedText?.Replace("\r\n", "\n"); this.actionTaken = actionTaken; this.allowQueryInLoop = allowQueryInLoop; this.correct = correct; this.types = types;
        if (!prefix.StartsWith(AliasPrefix, StringComparison.Ordinal)) throw new ArgumentException("an alias prefix starts with " + AliasPrefix);
        foreach (var (id, key) in ids) idOfKey[key] = id;
    }

    // baseline: the action as the model has it now (FlowExtractor, model keys; null for a new action); ids: the table of
    // the read the text edits (id -> key, "start" -> the Start node); edited: the text parsed without the table
    // (ModuleFlow.Read(text)); baseText: the read's text, for the patches that quote a line of it. editedText: the text
    // edited was parsed from: with it, the problems whose fix is certain carry the corrected text (Corrected, Added), checked
    // by reading it again; actionTaken: whether the module already has an action of that name (the name of a client action
    // the fix creates); allowQueryInLoop: the op carries the escape of QUERY_IN_LOOP (T3 is then not judged here);
    // restoredFrom: the action as an earlier read had it, which this text writes back (the undo of the LG2 battery): its
    // JavaScript nodes, the same name and the same code, come back as they were, not as new JavaScript. rewritten: the ids of the
    // text (+m1...) of elements of the read a three-way merge writes again with a new key (FlowMerge.Result.Rewritten): they are
    // the action's own (a JavaScript, a For Each, an aggregate in a loop the action had), never judged as new. types: what the module
    // knows that the text does not say (the apply's session; null in the preflight): the type of a name of the screen, the
    // sources of a screen aggregate, the attributes of a record in their order (the patches of T1/T2 need them). owner: where a
    // new screen, block or data action is created (the session resolves the header's owner; without it the create names the
    // owner as the text writes it, as the preflight sees it).
    public static FlowDiff Compute(FlowItem? baseline, IReadOnlyDictionary<string, string> ids, FlowItem edited, string? baseText = null, string prefix = AliasPrefix + ".",
        string? editedText = null, Func<string, bool>? actionTaken = null, bool allowQueryInLoop = false, FlowItem? restoredFrom = null, IFlowTypes? types = null,
        FlowOwnerRef? owner = null, IReadOnlySet<string>? rewritten = null, bool allowScreenJavaScript = false)
        => Compute(baseline, ids, edited, baseText, prefix, editedText, actionTaken, allowQueryInLoop, correct: true, restoredFrom, types, owner, rewritten, allowScreenJavaScript);

    private static FlowDiff Compute(FlowItem? baseline, IReadOnlyDictionary<string, string> ids, FlowItem edited, string? baseText, string prefix,
        string? editedText, Func<string, bool>? actionTaken, bool allowQueryInLoop, bool correct, FlowItem? restoredFrom = null, IFlowTypes? types = null,
        FlowOwnerRef? owner = null, IReadOnlySet<string>? rewritten = null, bool allowScreenJavaScript = false)
    {
        var diff = new FlowDiff(baseline, ids, baseText, prefix, editedText, actionTaken, allowQueryInLoop, correct, types, owner) { restoredFrom = restoredFrom, rewritten = rewritten, allowScreenJavaScript = allowScreenJavaScript };
        diff.Run(edited.Clone());
        return diff;
    }

    private string NewAlias() => prefix + "e" + ++aliases;
    private static string Ref(string key) => key.StartsWith(AliasPrefix, StringComparison.Ordinal) ? key : "@" + key;
    private static bool IsNew(string key) => key.StartsWith(AliasPrefix, StringComparison.Ordinal);
    // An element the text writes new that the action had (a three-way merge writes it again: rewritten), by its id in the text.
    private bool Rewritten(FlowItem item) => rewritten != null && mapped.FirstOrDefault(m => m.Value == item.Key).Key is { } id && rewritten.Contains(id);
    // An element new to the action: new in the text and not one the merge writes again (the rules of new elements judge these).
    private bool Fresh(FlowItem item) => IsNew(item.Key) && !Rewritten(item);
    private string IdOf(FlowItem item) => idOfKey.TryGetValue(item.Key, out var id) ? id : item.Key;
    private FlowProblem Problem(string code, string message, string? id = null, string? fix = null, string? patch = null)
    {
        var problem = new FlowProblem(code, message, id, fix, patch);
        Problems.Add(problem);
        return problem;
    }
    private JsonObject Op(string verb, params (string Key, JsonNode? Value)[] fields)
    {
        var op = new JsonObject { ["op"] = verb };
        foreach (var (key, value) in fields) if (value != null) op[key] = value;
        Ops.Add(op);
        return op;
    }

    // ---- identity ---------------------------------------------------------------------------------------------------------

    private void Run(FlowItem edited)
    {
        if (edited.Kind == "Preparation") {
            if (edited.Name != "Preparation")
                Problem("FLOW_PREPARATION_NAME", "Preparation has the fixed native name Preparation", null, "use preparation <Owner>.Preparation");
            if (edited.Items.Any(i => i.Role is "in" or "out"))
                Problem("FLOW_PREPARATION_PARAMETERS", "Preparation uses its owner's inputs and variables; it has no input or output parameters", null, "declare inputs on the screen, block or email");
        }
        if (baseline != null) {
            foreach (var item in baseline.Items.Where(i => FlowItem.Keyed(i.Role))) {
                baseByKey[item.Key] = item; ownerOf[item.Key] = baseline;
                if (item.Role == "node")
                    foreach (var parameter in item.Items.Where(p => FlowItem.Keyed(p.Role))) { baseByKey[parameter.Key] = parameter; ownerOf[parameter.Key] = item; }
            }
        }
        // The action: the header names the read's key (a new action has none).
        if (baseline == null) {
            if (FlowOwners.Owned(edited.Kind)) {
                // A screen, block or data action is created under the owner its header names (action Home.Save).
                var label = FlowPrinter.Labels.GetValueOrDefault(edited.Kind, "action");
                if (edited.Owner.Length == 0)
                    Problem("FLOW_NEW_ACTION_OWNER", "a new " + label + " belongs to a screen or block, and the header names none", null,
                        "write the owner before the name: " + label + " <Screen or Block>." + (edited.Name.Length > 0 ? edited.Name : "<Name>"));
                foreach (var flag in new[] { "Public", "Function" }.Where(f => edited.Prop(f) == "True"))
                    Problem("FLOW_ACTION_FLAG", "a " + label + " is never " + flag.ToLowerInvariant() + " (it belongs to its screen or block)", null,
                        "remove " + flag.ToLowerInvariant() + " from the header");
            } else if (edited.Kind is not ("ServerAction" or "ServiceAction" or "ClientAction"))
                Problem("FLOW_NEW_ACTION_KIND", "a new " + edited.Kind + " is not created by a text", null,
                    "a text without @key creates a server, service or client action of the module, or a screen, block or data action of its owner");
            if (edited.Key.Length > 0) Problem("FLOW_KEY_FOREIGN", "the header names @" + edited.Key + ", but no action of this module has that key; a new action is written without one", edited.Key,
                "write the header without @key to create the action, or read the action again (ssam_map view flow) and edit that text");
            edited.Key = prefix + "action";
        } else {
            if (edited.Key.Length > 0 && edited.Key != baseline.Key)
                Problem("FLOW_KEY_FOREIGN", "the header names @" + edited.Key + ", the action read is @" + baseline.Key, edited.Key, "keep the header's @key as it was read");
            if (edited.Kind != baseline.Kind)
                Problem("FLOW_ACTION_KIND", "the header writes a " + edited.Kind + ", the action is a " + baseline.Kind + ": the kind of an action is not changed by its text", null,
                    "keep the header's kind; a new action of another kind is a new text without @key");
            // The owner: the read's (a text that leaves it out keeps it); another one would move the action, which a text
            // does not do.
            if (edited.Owner.Length > 0 && !FlowOwners.Same(edited.Owner, baseline.Owner))
                Problem("FLOW_ACTION_OWNER", "the header puts " + baseline.Name + " under " + edited.Owner + ", but it belongs to " + (baseline.Owner.Length > 0 ? baseline.Owner : "the module")
                    + ": the text of an action does not move it", null,
                    "keep the owner as it was read (" + (baseline.Owner.Length > 0 ? baseline.Owner + "." + baseline.Name : baseline.Name) + "); moving an action to another screen or block is a refactoring");
            edited.Owner = baseline.Owner;
            edited.Key = baseline.Key;
        }
        // Every keyed element: kept (an id of the read on the same kind of element) or new.
        var claimed = new HashSet<string>(StringComparer.Ordinal);
        void Identify(FlowItem item, FlowItem owner)
        {
            var id = item.Key;
            if (item.Role == "node" && item.Kind == "StartNode" && id == "start") {
                if (baseline != null && ids.TryGetValue("start", out var startKey)) { item.Key = startKey; mapped[id] = startKey; claimed.Add(startKey); }
                else mapped[id] = item.Key = NewAlias();
                return;
            }
            if (ids.TryGetValue(id, out var key) && id != "start") {
                if (!baseByKey.TryGetValue(key, out var old)) {
                    Problem("FLOW_KEY_FOREIGN", "@" + id + " names an element this action no longer has (the read is older than the action)", id,
                        "read the action again and write the edit over that text");
                    mapped[id] = item.Key = NewAlias();
                    return;
                }
                var sameOwner = ownerOf[key] == baseline ? owner == edited : owner.Key == ownerOf[key].Key;
                if (old.Role != item.Role || !sameOwner) {
                    Problem("FLOW_KEY_ROLE", "@" + id + " is a" + (old.Role == "node" ? " node (" + old.Kind + ")" : " " + old.Role + " " + old.Name)
                        + " of the read, written here as " + Describe(item), id, "keep each id on the element it was read with; a new element is written without an id");
                    mapped[id] = item.Key = NewAlias();
                    return;
                }
                if (!claimed.Add(key)) {
                    Problem("FLOW_KEY_TWICE", "@" + id + " is written on two elements", id, "keep the id on one of them; the other is new, written without an id");
                    mapped[id] = item.Key = NewAlias();
                    return;
                }
                // A call of the other kind (Call=Client where the read's node is a server call) is another node too.
                var otherCall = item.Role == "node" && item.Kind == "Execute" && old.Kind == "Execute" && old.CallKind is { } wasCall && CallOf(item, old) != wasCall;
                // Call= of the kind the flow picks by default says nothing: left out, as the read leaves it out.
                if (item.Role == "node" && item.Kind == "Execute" && !otherCall && old.Prop(FlowRules.CallProperty) == null) item.Props.Remove(FlowRules.CallProperty);
                if (item.Role == "node" && (old.Kind != item.Kind || old.Opaque != item.Opaque || otherCall)) {
                    if (old.Opaque || item.Opaque) {
                        Problem("FLOW_OPAQUE_TOUCHED", "@" + id + " is an opaque " + old.Kind + " of the read (" + string.Join("; ", old.OpaqueReasons ?? []) + "): it cannot become a " + item.Kind,
                            id, "keep the opaque line as it was read", BaseLine(id));
                        mapped[id] = item.Key = key;
                        return;
                    }
                    // Another kind of node on the same id: the old node goes, a new one takes its place in the flow.
                    var alias = NewAlias();
                    Recreated.Add((id, key, alias));
                    claimed.Remove(key);
                    mapped[id] = item.Key = alias;
                    Created[id] = alias;
                    return;
                }
                mapped[id] = item.Key = key;
                return;
            }
            if (ReadId.IsMatch(id)) {
                Problem("FLOW_KEY_FOREIGN", "@" + id + " is not an id of this read" + (ids.Count > 0 ? "" : " (the action has no read)"), id,
                    "a new element is written without an id; an element of the read keeps the id it was read with");
                mapped[id] = item.Key = NewAlias();
                return;
            }
            var created = NewAlias();
            if (!id.StartsWith(FlowParserIds.Fresh, StringComparison.Ordinal) && mapped.ContainsKey(id))
                Problem("FLOW_KEY_TWICE", "@" + id + " is written on two elements", id, "give each new element its own id, or none");
            mapped[id] = item.Key = created;
            Created[id] = created;
        }
        foreach (var item in edited.Items.Where(i => FlowItem.Keyed(i.Role))) {
            Identify(item, edited);
            if (item.Role == "node")
                foreach (var parameter in item.Items.Where(p => FlowItem.Keyed(p.Role))) Identify(parameter, item);
        }
        // Connectors name ids: of the text (kept or new elements).
        void Targets(FlowItem item)
        {
            foreach (var edge in item.Edges.Keys.ToList()) {
                var target = item.Edges[edge];
                if (target.Length == 0) continue;
                if (mapped.TryGetValue(target, out var key)) { item.Edges[edge] = key; continue; }
                Problem("FLOW_JUMP_UNKNOWN", (edge == "Attached" ? "the comment is attached to @" : "-> @") + target + ": " + (ids.ContainsKey(target)
                    ? "that node of the read is not in the text (removed), so nothing can go to it" : "no element of the text has that id"), target,
                    ids.ContainsKey(target) ? "write the node again with its id, or send the connector to a node the text keeps" : "use the id of a node the text writes");
            }
            foreach (var part in item.Items.Where(p => !FlowItem.Keyed(p.Role))) Targets(part);
        }
        foreach (var node in edited.Items.Where(i => i.Role == "node")) Targets(node);
        // A connector from a node to itself (a loop body or branch left empty) is no flow the Studio accepts.
        var before = baseline?.Items.Where(i => i.Role == "node").ToDictionary(i => i.Key, StringComparer.Ordinal) ?? [];
        foreach (var node in edited.Items.Where(i => i.Role == "node")) {
            var edges = node.Edges.Where(e => e.Key != "Attached").Select(e => (e.Key, e.Value))
                .Concat(node.Items.Where(p => p.Role == "case").Select(p => ("case " + (p.Prop("Value") ?? ""), p.Edges.GetValueOrDefault("Target") ?? "")));
            foreach (var (edge, to) in edges)
                if (to == node.Key && !(before.TryGetValue(node.Key, out var old) && old.Edges.GetValueOrDefault(edge) == to)) {
                    var id = mapped.FirstOrDefault(m => m.Value == node.Key).Key ?? node.Key;
                    Problem("FLOW_SELF_LOOP", "@" + id + " " + node.Kind + ": its " + edge + " goes to itself (an empty branch or loop body)", id,
                        "send it to the node that comes next, or write a step in the branch");
                }
            // Two branches of one If or Switch straight to the same node: the platform refuses that connector ("Cannot change
            // the target node"). Only a node whose branches the text changes is judged.
            if (node.Kind is "IfNode" or "SwitchNode") {
                var branches = Branches(node).Where(t => t.Length > 0).ToList();
                var met = branches.GroupBy(t => t).FirstOrDefault(g => g.Count() > 1)?.Key;
                if (met != null && !(before.TryGetValue(node.Key, out var was) && Branches(was).SequenceEqual(Branches(node)))) {
                    var id = mapped.FirstOrDefault(m => m.Value == node.Key).Key ?? node.Key;
                    var at = mapped.FirstOrDefault(m => m.Value == met).Key ?? met;
                    Problem("FLOW_BRANCHES_MEET", "@" + id + " " + (node.Kind == "IfNode" ? "if" : "switch") + ": two branches go straight to @" + at
                        + "; the Studio keeps no " + (node.Kind == "IfNode" ? "If" : "Switch") + " whose branches meet at once", id,
                        node.Kind == "IfNode" ? "remove the if (its branches are the same), or write the step that one branch does"
                            : "join those cases in one condition, or write the step that one of them does");
                }
            }
        }
        // A screen or block action returns nothing (the Studio gives it no output): a new output is refused.
        if (edited.Kind == "ScreenAction")
            foreach (var output in edited.Items.Where(i => i.Role == "out" && IsNew(i.Key)))
                Problem("FLOW_SCREEN_ACTION_OUTPUT", "out " + output.Name + ": a screen or block action has no output parameters", null,
                    "keep the value in a local or screen variable, or return it from a client action the screen action calls");
        Expected = edited;
        SortRule(edited);
        if (baseline != null) Opaque(edited);
        NewNodeNames(edited);
        ForEachRule(edited);
        JavaScriptRule(edited);
        QueryInLoopRule(edited);
        RecordLiteralRule(edited);
        AliasRule(edited);
        MandatoryRule(edited);
        if (correct && editedText != null && corrections.Count > 0) Correct();
        if (Problems.Count > 0) return;
        Write(edited);
    }

    // ODC: the value of an assignment is never a record literal (the platform refuses it, "Expression Value does not support
    // record literals"): an assignment the text writes new or changes with one is refused with the fix, before anything is
    // written. A record literal is an argument's value (ListAppend's Element), or a record is assigned field by field.
    // O11: the expression parser reads no record literal at all (the Studio builds one only in its own editor): a value of an
    // assignment or an argument the text writes new or changes as one is refused here, with the fix, instead of being kept as
    // unread text that reads back exact and only the Verify refuses (correction 2: ListAppend(Element={ Key: "k", ... })).
    private void RecordLiteralRule(FlowItem edited)
    {
        var before = baseline?.Items.Where(i => i.Role == "node").GroupBy(i => i.Key).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal) ?? [];
        if (Anvil.Core.MessageExpectations.Lane != "odc") {
            foreach (var node in edited.Items.Where(i => i.Role == "node"))
                foreach (var part in node.Items.Where(p => p.Role is "assignment" or "argument")) {
                    if (part.Prop("Value") is not { } value || FlowMapping.SplitRecord(value) is not { } fields) continue;
                    if (before.TryGetValue(node.Key, out var was) && was.Items.Any(p => p.Role == part.Role && p.Name == part.Name && p.Prop("Variable") == part.Prop("Variable") && p.Prop("Value") == value)) continue;
                    var id = mapped.FirstOrDefault(m => m.Value == node.Key).Key ?? "";
                    var what = part.Role == "assignment" ? "assign " + (part.Prop("Variable") ?? "?") + " = " + value : (part.Name.Length > 0 ? part.Name + "=" : "") + value;
                    Problem("FLOW_VALUE_RECORD_LITERAL", "@" + id + " " + what + ": O11 reads no record literal in an expression (its parser does not; only the Studio's editor builds one)", id,
                        "build the record in a local of its type and assign its fields (" + string.Join(", ", fields.Take(3).Select(f => "<Local>." + f.Field + " = " + f.Value)) + (fields.Count > 3 ? ", ..." : "")
                        + "), then pass the local; or map a record you have with Source mapTo { Field: value }");
                }
            return;
        }
        foreach (var node in edited.Items.Where(i => i.Role == "node" && i.Kind == "AssignNode"))
            foreach (var assignment in node.Items.Where(p => p.Role == "assignment")) {
                if (assignment.Prop("Value") is not { } value || FlowMapping.SplitRecord(value) is not { } fields) continue;
                if (before.TryGetValue(node.Key, out var was) && was.Items.Any(p => p.Role == "assignment" && p.Prop("Variable") == assignment.Prop("Variable") && p.Prop("Value") == value)) continue;
                var id = mapped.FirstOrDefault(m => m.Value == node.Key).Key ?? "";
                var variable = assignment.Prop("Variable") ?? "?";
                Problem("FLOW_VALUE_RECORD_LITERAL", "@" + id + " assign " + variable + " = " + value + ": ODC takes no record literal as the value of an assignment (the platform refuses it)", id,
                    "assign the fields one by one (" + string.Join(", ", fields.Take(3).Select(f => variable + "." + f.Field + " = " + f.Value)) + (fields.Count > 3 ? ", ..." : "")
                    + "), or pass the literal as the argument of a call");
            }
    }

    // A mapping (Source mapTo { ... }) or (ODC) a record literal the text writes new or changes, into a record whose mandatory
    // attributes it leaves empty (an entity's identifier always): the Verify refuses it (AttributeMappingRequiredExpression,
    // RecordLiteralFieldRequiredExpression). Refused here on both lanes, before anything is written, with the value that names them
    // as the patch when each value is certain (an identifier: NullIdentifier()) and the module says the order of the record's
    // attributes (correction 2: d-p8, d-p9, d-l4 on ODC; the 24.1 fixes: O11 refused it only when it wrote the mapping, with no
    // patch). The record is the type of the variable assigned, the item of the list of a ListAppend/ListInsert, or the type of the
    // input the argument passes to the action it calls (the 24.1 fixes: an argument of another action was not judged). O11 reads
    // no record literal at all (FLOW_VALUE_RECORD_LITERAL says it): only its mappings are judged here.
    private void MandatoryRule(FlowItem edited)
    {
        if (types == null) return;
        var odc = Anvil.Core.MessageExpectations.Lane == "odc";
        var before = baseline?.Items.Where(i => i.Role == "node").GroupBy(i => i.Key).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal) ?? [];
        foreach (var node in edited.Items.Where(i => i.Role == "node"))
            foreach (var part in node.Items.Where(p => p.Role is "assignment" or "argument")) {
                if (part.Prop("Value") is not { } value) continue;
                var mapping = FlowMapping.Split(value);
                if (mapping == null && !odc) continue;
                var fields = mapping?.Fields ?? FlowMapping.SplitRecord(value);
                if (fields == null) continue;
                if (before.TryGetValue(node.Key, out var was) && was.Items.Any(p => p.Role == part.Role && p.Name == part.Name && p.Prop("Variable") == part.Prop("Variable") && p.Prop("Value") == value)) continue;
                var target = part.Role == "assignment" ? (part.Prop("Variable") is { } variable && FlowSyntax.IsIdentifier(variable.Trim()) ? TypeOf(edited, variable) : null)
                    : node.Kind == "Execute" && Callee(node) is "ListAppend" or "ListInsert" ? (part.Name == "Element" && Argument(node, "List") is { } list ? ItemType(edited, list) : null)
                    : node.Kind == "Execute" && node.Prop("Action") is { } called ? types.InputTypeOf(called, node.Prop(FlowRules.CallProperty), part.Name)
                    : null;
                if (target == null) continue;
                var record = target.Trim().EndsWith(" List", StringComparison.Ordinal) ? target.Trim()[..^5].Trim() : target.Trim();
                // tx-visitacerta (junction 24-1-final): `Source mapTo { Value: R }`, with R a record of the item and no attribute
                // Value in the target, is the platform's mapping of the record R whole (every attribute copied from it, none left
                // empty): the read back judges it (FLOW_MAPPING_PLATFORM, or FLOW_MAPPING_TYPES when the platform keeps no such
                // mapping), never this rule.
                if (mapping is { } studio && fields is [("Value", var whole)] && types.AttributesOf(record) is { } attributes
                    && !attributes.Contains("Value", StringComparer.OrdinalIgnoreCase) && Anvil.Core.ModelSession.RecordOfItem(edited, studio.Source, whole.Trim(), types)) continue;
                if (types.MandatoryOf(record) is not { } mandatory) continue;
                // What the read's value of the same part already left empty is the action's own (judged by the Verify of the module
                // as it was): only an attribute this text leaves empty is refused.
                var read = was?.Items.FirstOrDefault(p => p.Role == part.Role && p.Name == part.Name && p.Prop("Variable") == part.Prop("Variable"))?.Prop("Value") is { } readValue
                    ? FlowMapping.Split(readValue)?.Fields ?? FlowMapping.SplitRecord(readValue) : null;
                var missing = mandatory.Where(m => !fields.Any(f => string.Equals(f.Field, m.Attribute, StringComparison.OrdinalIgnoreCase))
                    && !(read != null && !read.Any(f => string.Equals(f.Field, m.Attribute, StringComparison.OrdinalIgnoreCase)))).ToList();
                if (missing.Count == 0) continue;
                var id = mapped.FirstOrDefault(m => m.Value == node.Key).Key ?? "";
                string? corrected = null;
                if (missing.All(m => m.Value != null) && types.AttributesOf(record) is { } order) {
                    var all = fields.Concat(missing.Select(m => (Field: m.Attribute, Value: m.Value!)))
                        .OrderBy(f => order.ToList().FindIndex(a => string.Equals(a, f.Field, StringComparison.OrdinalIgnoreCase)) is var at && at < 0 ? int.MaxValue : at).ToList();
                    corrected = mapping is { } m2 ? FlowMapping.Compose(m2.Source, all) : "{ " + string.Join(", ", all.Select(f => f.Field + ": " + f.Value)) + " }";
                }
                var what = part.Role == "assignment" ? "assign " + part.Prop("Variable") + " = " + value : part.Name + "=" + value;
                var problem = Problem("FLOW_MAPPING_TYPES", "@" + id + " " + what + ": the " + (mapping != null ? "mapping" : "record literal") + " leaves the mandatory attribute"
                    + (missing.Count > 1 ? "s " : " ") + string.Join(", ", missing.Select(m => m.Attribute)) + " of " + record + " empty (the Verify refuses it)", id,
                    corrected != null ? "name " + (missing.Count > 1 ? "them" : "it") + " too: " + string.Join(", ", missing.Select(m => m.Attribute + ": " + m.Value)) + " (the patch)"
                        : "map " + string.Join(", ", missing.Select(m => m.Attribute + (m.Value != null ? ": " + m.Value : ""))) + " too (a mandatory attribute is never left empty)", corrected);
                if (corrected != null) {
                    var old = value; var now = corrected;
                    corrections.Add(new BlockFix(problem, node.Key, [], [], Build: (view, start) => {
                        var depth = TextView.Depth(view.Lines[start]);
                        var lines = view.Lines[start..view.End(start)].Select(l => TextView.Relative(l, depth)).ToList();
                        var at = lines.FindIndex(l => l.Contains(old, StringComparison.Ordinal));
                        if (at < 0) return null;
                        var i = lines[at].IndexOf(old, StringComparison.Ordinal);
                        lines[at] = lines[at][..i] + now + lines[at][(i + old.Length)..];
                        return (lines, []);
                    }));
                }
            }
    }

    // An alias of a source of an aggregate of the read, written new or renamed onto the name of a parameter, local or output
    // node of the action that the read's expressions of that aggregate (filters, joins, sorts, columns) name: inside the
    // aggregate the aliases come first, so those expressions would read the source instead, and the text reads back the same
    // (correction 2: M renamed L, and `M.Qty > L.Qty` became `L.Qty > L.Qty`, the local L never used). Refused with a free name.
    private void AliasRule(FlowItem edited)
    {
        if (baseline == null) return;
        var names = edited.Items.Concat(baseline.Items).Where(i => i.Role is "in" or "out" or "local" || i.Role == "node" && Outputs.Contains(i.Kind))
            .Select(i => i.Name).Where(n => n.Length > 0).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var before = baseline.Items.Where(i => i.Role == "node" && i.Kind == "AggregateNode").GroupBy(i => i.Key).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        foreach (var node in edited.Items.Where(i => i.Role == "node" && i.Kind == "AggregateNode")) {
            if (!before.TryGetValue(node.Key, out var was)) continue;
            var aliases = was.Items.Where(p => p.Role == "source").Select(p => p.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
            var read = Texts(was).ToList();
            foreach (var source in node.Items.Where(p => p.Role == "source" && p.Name.Length > 0 && !aliases.Contains(p.Name) && names.Contains(p.Name))) {
                if (read.FirstOrDefault(t => Mentions(t, source.Name)) is not { } use) continue;
                var id = mapped.FirstOrDefault(m => m.Value == node.Key).Key ?? "";
                var taken = new HashSet<string>(names.Concat(aliases).Concat(node.Items.Where(p => p.Role == "source").Select(p => p.Name)), StringComparer.OrdinalIgnoreCase);
                Problem("FLOW_RENAME_CAPTURED", "@" + id + " " + node.Name + ": the source " + (source.Prop("Source") ?? "") + " is given the alias " + source.Name
                    + ", the name of an element of the action that the read's `" + (use.Length <= 120 ? use : use[..120] + "…") + "` of this aggregate names: inside the aggregate its aliases come first, so that "
                    + source.Name + " would read the source instead", id, "give the source an alias no element of the action has, e.g. " + Numbered(source.Name, taken.Contains));
            }
        }
        static IEnumerable<string> Texts(FlowItem item) => item.Items.Where(p => p.Role != "source")
            .SelectMany(p => p.Props.Values.Where(v => v.Type == 'e').Select(v => v.Text).Concat(Texts(p)));
    }

    // The kind of call a node of the text makes: what it writes (Call=), else the kind its flow picks by default, which the
    // read shows as the node's kind when it wrote no Call=, and as the other kind when it did.
    private static string CallOf(FlowItem now, FlowItem read) => now.Prop(FlowRules.CallProperty)
        ?? (read.Prop(FlowRules.CallProperty) is { } written ? (written == "Client" ? "Server" : "Client") : read.CallKind!);

    // The connectors of an If or a Switch, in order (True, False; the cases, then Otherwise).
    private static IEnumerable<string> Branches(FlowItem node) => node.Kind == "IfNode"
        ? [node.Edges.GetValueOrDefault("TrueTarget", ""), node.Edges.GetValueOrDefault("FalseTarget", "")]
        : node.Items.Where(p => p.Role == "case").Select(p => p.Edges.GetValueOrDefault("Target", "")).Append(node.Edges.GetValueOrDefault("OtherwiseTarget", ""));

    private static string Describe(FlowItem item) => item.Role == "node" ? "a " + item.Kind : item.Role + " " + item.Name;

    // The line of the read that names this id (the patch of a touched opaque node).
    private string? BaseLine(string id)
    {
        if (baseText == null) return null;
        foreach (var line in baseText.Split('\n'))
            if (line.EndsWith(" @" + id, StringComparison.Ordinal)) return line;
        return null;
    }

    // Opaque nodes stay as they were read: same name, same connector, nothing written on them; a new one cannot be written.
    private void Opaque(FlowItem edited)
    {
        var byKey = edited.Items.Where(i => i.Role == "node").ToDictionary(i => i.Key, StringComparer.Ordinal);
        foreach (var old in baseline!.Items.Where(i => i.Role == "node" && i.Opaque)) {
            var id = idOfKey.GetValueOrDefault(old.Key, old.Key);
            var why = " (" + string.Join("; ", old.OpaqueReasons ?? []) + ")";
            if (!byKey.TryGetValue(old.Key, out var now)) {
                Problem("FLOW_OPAQUE_TOUCHED", "@" + id + " opaque " + old.Kind + " was removed; an opaque node is kept as it was read" + why, id,
                    "write its line again where it was", BaseLine(id));
                continue;
            }
            if (now.Name != old.Name || now.Props.Count > 0 || now.Items.Count > 0 || !now.Edges.OrderBy(e => e.Key).SequenceEqual(old.Edges.OrderBy(e => e.Key)))
                Problem("FLOW_OPAQUE_TOUCHED", "@" + id + " opaque " + old.Kind + " was changed or moved; an opaque node is kept as it was read" + why, id,
                    "keep its line and the node that follows it as they were read", BaseLine(id));
        }
        foreach (var node in edited.Items.Where(i => i.Role == "node" && i.Opaque && IsNew(i.Key)))
            Problem("FLOW_OPAQUE_TOUCHED", "a new opaque " + node.Kind + " cannot be written: an opaque line only stands for a node the read could not show", null,
                "write the node in its own form (node " + node.Kind + "(...) with @{...})");
    }

    // A node name is unique in its action (without case). A new node on a taken name gets the Studio's name for a copy
    // (Foo -> Foo2, Foo2 -> Foo3), reported in NodeNames; an existing node renamed onto a taken name is refused.
    // The nodes whose name the action's expressions read (Name.Output): their names are unique in the action. Other nodes
    // (a navigate named after its screen) may share a name.
    private static readonly HashSet<string> Outputs = new(StringComparer.Ordinal) {
        "Execute", "AggregateNode", "SQLNode", "JavaScriptNode", "JSONSerializeNode", "JSONDeserializeNode", "ExcelToRecordListNode", "RecordListToExcelNode" };

    private void NewNodeNames(FlowItem edited)
    {
        var taken = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var nodes = edited.Items.Where(i => i.Role == "node" && i.Name.Length > 0 && Outputs.Contains(i.Kind)).ToList();
        var before = baseline?.Items.Where(i => i.Role == "node").ToDictionary(i => i.Key, i => i.Name, StringComparer.Ordinal) ?? [];
        // The names the read already has stay as they are (even repeated); a node the text renames is judged.
        foreach (var node in nodes.Where(n => !IsNew(n.Key)).OrderBy(n => before.GetValueOrDefault(n.Key) == n.Name ? 0 : 1)) {
            if (taken.Add(node.Name) || before.GetValueOrDefault(node.Key) == node.Name) continue;
            var id = idOfKey.GetValueOrDefault(node.Key, node.Key);
            Problem("FLOW_NODE_NAME_TAKEN", "@" + id + " is named " + node.Name + ", a name another node of this action has", id,
                "give it a name no other node of the action has, e.g. " + Numbered(node.Name, taken.Contains));
        }
        foreach (var node in nodes.Where(n => IsNew(n.Key))) {
            if (taken.Add(node.Name)) continue;
            var given = Numbered(node.Name, taken.Contains);
            taken.Add(given);
            NodeNames.Add((mapped.First(m => m.Value == node.Key).Key, node.Name, given));
            node.Name = given;
        }
    }

    // The Studio's name for a copy: the stem without its trailing digits, numbered from the next one (End -> End2).
    internal static string Numbered(string name, Func<string, bool> taken)
    {
        var match = Regex.Match(name, @"^(.*?[^0-9])([0-9]+)$");
        var stem = match.Success ? match.Groups[1].Value : name;
        var n = match.Success && int.TryParse(match.Groups[2].Value, out var current) ? current + 1 : 2;
        while (taken(stem + n)) n++;
        return stem + n;
    }

    private static IEnumerable<string> Next(FlowItem node) =>
        node.Edges.Where(e => e.Key != "Attached").Select(e => e.Value).Concat(node.Items.Where(i => i.Role == "case").Select(c => c.Edges.GetValueOrDefault("Target") ?? "")).Where(t => t.Length > 0);

    // Whether the walk from `from` reaches `target` before coming back to the loop.
    private static bool Reaches(Dictionary<string, FlowItem> nodes, string from, string target, string loop)
    {
        var pending = new Stack<string>(); var seen = new HashSet<string>(StringComparer.Ordinal);
        if (from.Length > 0) pending.Push(from);
        while (pending.TryPop(out var key)) {
            if (key == target) return true;
            if (key == loop || !seen.Add(key) || !nodes.TryGetValue(key, out var node)) continue;
            foreach (var next in Next(node)) pending.Push(next);
        }
        return false;
    }

    private static bool Same(string a, string b) => string.Equals(a.Trim(), b.Trim(), StringComparison.OrdinalIgnoreCase);

    // Whether an expression names the variable (outside literals, after no dot).
    private static bool Mentions(string expression, string variable) => FlowEdits.Renamed(expression, variable, "\u0001") != expression;

    // A value read from the current item, written relative to it (Source.Current.A.B -> A.B, as a mapping reads); null
    // when it reads the item whole or something the mapping cannot name.
    private static string? Relative(string value, string current)
    {
        var relative = FlowEdits.WithoutPrefix(value, current + ".");
        return relative.Contains(current, StringComparison.OrdinalIgnoreCase) || relative.Trim().Length == 0 ? null : relative;
    }

    private static string Callee(FlowItem node)
    {
        var action = node.Prop("Action") ?? "";
        return action[(action.LastIndexOf('.') + 1)..];
    }

    private static string? Argument(FlowItem node, string name) => node.Items.FirstOrDefault(i => i.Role == "argument" && i.Name == name)?.Prop("Value");

    // ---- ops ---------------------------------------------------------------------------------------------------------------

    private void Write(FlowItem edited)
    {
        var actionRef = Ref(edited.Key);
        var oldNodes = baseline?.Items.Where(i => i.Role == "node").ToDictionary(i => i.Key, StringComparer.Ordinal) ?? new Dictionary<string, FlowItem>(StringComparer.Ordinal);
        var newNodes = edited.Items.Where(i => i.Role == "node").ToList();
        // 1. Names: the action and its parameters by rename (it rewrites what names them); then creates.
        if (baseline != null && edited.Name != baseline.Name) { Op("rename", ("target", actionRef), ("name", edited.Name)); Renamed.Add((actionRef, baseline.Name, edited.Name)); Touched.Add(edited.Key); }
        var parameterOwners = new List<(FlowItem? Old, FlowItem Now, string Ref)> { (baseline, edited, actionRef) };
        foreach (var node in newNodes.Where(n => n.Kind is "SQLNode" or "JavaScriptNode"))
            parameterOwners.Add((oldNodes.GetValueOrDefault(node.Key), node, Ref(node.Key)));
        foreach (var (old, now, ownerRef) in parameterOwners.Where(o => o.Old != null))
            RenameParameters(old!, now, ReferenceEquals(now, edited));
        if (baseline == null) {
            // A module action under the module; a screen, block or data action under the owner the session resolved (or, read
            // without a module, the owner as the text names it).
            var parent = FlowOwners.Owned(edited.Kind) ? owner?.Ref ?? edited.Owner : "@espace";
            Op("create", ("parent", parent), ("type", ActionType(edited.Kind, owner?.Web == true)), ("name", edited.Name), ("as", actionRef));
            Touched.Add(edited.Key);
        }
        // 2. New nodes (their own parameters with them), new action parameters.
        foreach (var node in newNodes.Where(n => IsNew(n.Key))) {
            var create = Op("create", ("parent", actionRef), ("type", NodeType(node.Kind)), ("name", node.Name.Length > 0 ? node.Name : null), ("as", node.Key));
            if (node.Kind == "Execute") { create["_execute"] = node.Prop("Action") ?? ""; if (node.Prop(FlowRules.CallProperty) is { } call) create["_call"] = call; }
            Touched.Add(node.Key);
        }
        foreach (var (old, now, ownerRef) in parameterOwners) {
            var ownerNew = old == null || IsNew(now.Key);
            foreach (var parameter in now.Items.Where(p => p.Role is "in" or "out" or "local" && (ownerNew || IsNew(p.Key)))) {
                Op("create", ("parent", ownerRef), ("type", ParameterType(now, parameter)), ("name", parameter.Name), ("as", parameter.Key));
                Touched.Add(parameter.Key);
            }
        }
        // 3. Values of the action, the parameters and the nodes (an Execute node's Action before its arguments).
        Values(edited, baseline, actionRef);
        foreach (var (old, now, ownerRef) in parameterOwners)
            foreach (var parameter in now.Items.Where(p => p.Role is "in" or "out" or "local"))
                Values(parameter, old?.Items.FirstOrDefault(p => p.Key == parameter.Key), Ref(parameter.Key));
        foreach (var node in newNodes) {
            var old = oldNodes.GetValueOrDefault(node.Key);
            if (node.Name != (old?.Name ?? "") && old != null) { Op("set", ("target", Ref(node.Key)), ("prop", "Name"), ("value", node.Name)); Touched.Add(node.Key); }
            Values(node, old, Ref(node.Key));
        }
        Events(edited, baseline, actionRef);
        // 3b. The connectors of an If, a For Each or a Switch that change are disconnected before any is linked again: a legal
        // final graph can pass through an illegal one ("Cannot change the target node": the new body of a For Each still its
        // old exit). Every node keeps its key; a connector that does not change is not touched.
        foreach (var old in oldNodes.Values) {
            if (old.Kind is not ("IfNode" or "ForEachNode" or "SwitchNode") || newNodes.FirstOrDefault(n => n.Key == old.Key) is not { } now) continue;
            foreach (var edge in old.Edges.Where(e => e.Key != "Attached" && e.Value.Length > 0)) {
                if (now.Edges.GetValueOrDefault(edge.Key, "") == edge.Value) continue;
                Op("set", ("target", Ref(old.Key)), ("prop", edge.Key))["value"] = null;
                Touched.Add(old.Key);
            }
            if (old.Kind != "SwitchNode") continue;
            var previous = old.Items.Where(i => i.Role == "case").ToList();
            var wanted = now.Items.Where(i => i.Role == "case").ToList();
            for (var i = 0; i < previous.Count; i++) {
                var to = previous[i].Edges.GetValueOrDefault("Target", "");
                if (to.Length == 0 || i < wanted.Count && wanted[i].Edges.GetValueOrDefault("Target", "") == to) continue;
                Op("set", ("target", Ref(previous[i].Key)), ("prop", "Target"))["value"] = null;
                Touched.Add(old.Key);
            }
        }
        // 4. Parts: arguments by name, every other part group replaced when it changed.
        foreach (var node in newNodes) Parts(node, oldNodes.GetValueOrDefault(node.Key));
        // 5. Connectors.
        foreach (var node in newNodes) Edges(node, oldNodes.GetValueOrDefault(node.Key));
        // 6. Removed nodes (forced: what named them is rewritten by this text), then removed parameters (refused while
        // something outside the action uses them, e.g. a consumer of an input).
        foreach (var old in oldNodes.Values.Where(o => !newNodes.Any(n => n.Key == o.Key))) {
            Op("delete", ("target", Ref(old.Key)), ("force", true));
            Deleted.Add(old.Key); Touched.Add(old.Key);
        }
        foreach (var (old, now, ownerRef) in parameterOwners.Where(o => o.Old != null && !IsNew(o.Now.Key)))
            foreach (var parameter in old!.Items.Where(p => p.Role is "in" or "out" or "local" && !now.Items.Any(n => n.Key == p.Key))) {
                Op("delete", ("target", Ref(parameter.Key)));
                Deleted.Add(parameter.Key); Touched.Add(parameter.Key);
            }
        // 7. Order of the parameters: kept ones in the read's order, new ones last; moved when the text orders them otherwise.
        foreach (var (old, now, ownerRef) in parameterOwners)
            foreach (var role in new[] { "in", "out", "local" }) {
                var wanted = now.Items.Where(p => p.Role == role).Select(p => p.Key).ToList();
                var kept = old?.Items.Where(p => p.Role == role && wanted.Contains(p.Key)).Select(p => p.Key).ToList() ?? [];
                var result = kept.Concat(wanted.Where(IsNew)).ToList();
                if (result.SequenceEqual(wanted)) continue;
                for (var i = 0; i < wanted.Count; i++) {
                    if (i == 0) Op("move", ("target", Ref(wanted[0])), ("first", true));
                    else Op("move", ("target", Ref(wanted[i])), ("after", Ref(wanted[i - 1])));
                    Touched.Add(wanted[i]);
                }
            }
    }

    // The parameters (and locals) of one owner the text renames, in an order where no rename takes a name another parameter
    // still has (the verb refuses that clash): a parameter the text removes whose name a rename takes goes to a free name first
    // (it is deleted at the end), and names that trade places go through a free name (correction 2: removing A and renaming B
    // to A, or swapping A and B, failed with "'A' clashes"). The expressions are read with every rename at once (ByRename).
    private void RenameParameters(FlowItem old, FlowItem now, bool action)
    {
        static bool Same(string a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);
        var olds = old.Items.Where(p => p.Role is "in" or "out" or "local").ToList();
        var steps = now.Items.Where(p => p.Role is "in" or "out" or "local" && !IsNew(p.Key))
            .Select(p => (Key: p.Key, From: olds.FirstOrDefault(o => o.Key == p.Key)?.Name, To: p.Name)).Where(s => s.From != null && s.From != s.To)
            .Select(s => (s.Key, From: s.From!, s.To)).ToList();
        if (steps.Count == 0) return;
        var holder = olds.GroupBy(p => p.Key).ToDictionary(g => g.Key, g => g.First().Name, StringComparer.Ordinal);
        var taken = new HashSet<string>(old.Items.Concat(now.Items).Where(i => i.Name.Length > 0).Select(i => i.Name), StringComparer.OrdinalIgnoreCase);
        string Free(string stem) { var name = Numbered(stem, taken.Contains); taken.Add(name); return name; }
        void Rename(string key, string name) { Op("rename", ("target", Ref(key)), ("name", name)); holder[key] = name; Touched.Add(key); }
        // A removed parameter whose name a rename takes: out of the way first.
        foreach (var gone in olds.Where(p => !now.Items.Any(n => n.Key == p.Key) && steps.Any(s => Same(s.To, p.Name)))) {
            var free = Free(gone.Name);
            Rename(gone.Key, free);
            if (action) renames.Add((gone.Name, free));
        }
        var pending = steps.ToList();
        for (var round = 0; pending.Count > 0 && round < 4 * steps.Count + 4; round++) {
            var ready = pending.FindIndex(s => !holder.Any(h => h.Key != s.Key && Same(h.Value, s.To)));
            if (ready < 0) {
                // Names that trade places: one of them through a free name. A name a parameter the text keeps still has is a
                // clash the verb reports.
                var cycle = pending.FindIndex(s => holder.Where(h => h.Key != s.Key && Same(h.Value, s.To)).All(h => pending.Any(p => p.Key == h.Key)));
                if (cycle >= 0) { Rename(pending[cycle].Key, Free(pending[cycle].To)); continue; }
                ready = 0;
            }
            var (key, from, to) = pending[ready];
            pending.RemoveAt(ready);
            Rename(key, to);
            Renamed.Add((Ref(key), from, to));
            if (action) renames.Add((from, to));
        }
    }

    // The native type of a new action (LogicOrder.ActionType's): a screen action is the Reactive/Mobile one, or the
    // Traditional one under a Traditional owner.
    private static string ActionType(string kind, bool web) => kind switch {
        "ServerAction" => "IServerAction", "ServiceAction" => "IServiceAction", "ClientAction" => "IClientAction",
        "ScreenAction" => web ? "OutSystems.Model.UI.Web.IScreenAction" : "OutSystems.Model.UI.Mobile.IScreenAction",
        "DataAction" => "IDataAction", "Preparation" => "IPreparation",
        _ => throw new InvalidOperationException("a new " + kind + " is not created by a text without key")
    };

    // The native type a node of this kind is created as (Execute: decided by the action it calls, FlowApply).
    private static string NodeType(string kind) => kind switch {
        "Execute" => "IExecuteServerActionNode",
        "AssignNode" or "IfNode" or "ForEachNode" or "SwitchNode" or "EndNode" or "StartNode" or "ExceptionHandlerNode" or "RaiseExceptionNode"
            or "AggregateNode" or "SQLNode" => "I" + kind,
        _ => "OutSystems.Model.Logic.Nodes.I" + kind
    };

    private static string ParameterType(FlowItem owner, FlowItem parameter) => (owner.Kind, parameter.Role) switch {
        ("SQLNode", _) => "ISQLInputParameter",
        (_, "in") => "IInputParameter",
        (_, "out") => "IOutputParameter",
        _ => "ILocalVariable"
    };

    // The properties of an element that changed: set to the edited value, or to the property's default when the text left
    // it out. A new element starts with the Studio's defaults: only what the text says is set.
    private void Values(FlowItem now, FlowItem? old, string target)
    {
        var before = old?.Props ?? new SortedDictionary<string, FlowValue>(StringComparer.Ordinal);
        foreach (var name in now.Props.Keys.Union(before.Keys).ToList()) {
            if (name == "MasterSource") continue;   // set after the sources of the aggregate (Parts)
            if (name == FlowRules.CallProperty) continue;   // the kind of the call: read by the Action set and the create
            // A value the platform computes from another one is never written; changing it alone is refused.
            if (FlowRules.ComputedFrom(now.Kind, name) is { } source) {
                if (old != null && now.Props.GetValueOrDefault(name)?.Text != before.GetValueOrDefault(name)?.Text && now.Prop(source) == old.Prop(source))
                    Problem("FLOW_VALUE_COMPUTED", "@" + IdOf(now) + " " + name + " follows from its " + source + " (the platform computes it): it does not change alone", IdOf(now),
                        "change the " + source + " (an asynchronous script calls $resolve) or keep " + name + " as it was read");
                continue;
            }
            now.Props.TryGetValue(name, out var value);
            before.TryGetValue(name, out var was);
            if (value == was || value != null && was != null && value.Type == was.Type && value.Text == was.Text) continue;
            if (now.Key.Length > 0) Touched.Add(now.Key);
            if (value is { Type: 'e' } && was is { Type: 'e' } && ByRename(was.Text) == value.Text) continue;
            if (value != null) {
                Set(target, name, value);
                if (name == "Action" && now.Prop(FlowRules.CallProperty) is { } call) Ops[^1]["_call"] = call;
                continue;
            }
            if (TryUnset(now.Kind, name, was!, out var unset)) { var op = Op("set", ("target", target), ("prop", name)); op["value"] = unset; }
            else Problem("FLOW_VALUE_REQUIRED", (now.Role == "action" ? "the action" : "@" + IdOf(now)) + " " + name + " cannot be left out (it has no empty value)", IdOf(now),
                "write it on the element's @{...} line, e.g. @{" + name + "=" + was!.Text + "}");
        }
    }

    private void Set(string target, string name, FlowValue value)
    {
        var op = Op("set", ("target", target), ("prop", name));
        op["value"] = value.Type switch {
            'v' when value.Text is "True" or "False" => JsonValue.Create(value.Text == "True"),
            _ => JsonValue.Create(value.Text)
        };
        if (value.Type == 'r') op["_ref"] = name;
    }

    // The value that leaves a property out (its default): "" for an expression or text, null for a reference, the
    // property's default for a value (FlowRules.DefaultText); false when it has none (the text must write it).
    private static bool TryUnset(string kind, string name, FlowValue was, out JsonNode? value)
    {
        value = null;
        switch (was.Type) {
            case 'e' or 't': value = JsonValue.Create(""); return true;
            case 'r': return true;
        }
        if (FlowRules.DefaultText(kind, name, was.Text) is not { } text) return false;
        value = text is "True" or "False" ? JsonValue.Create(text == "True") : JsonValue.Create(text);
        return true;
    }

    // Lifecycle events of the action (a data action's OnAfterFetch): handler and arguments.
    private void Events(FlowItem now, FlowItem? old, string actionRef)
    {
        var before = old?.Items.Where(i => i.Role == "event").ToDictionary(i => i.Name, StringComparer.Ordinal) ?? new Dictionary<string, FlowItem>(StringComparer.Ordinal);
        foreach (var handler in now.Items.Where(i => i.Role == "event")) {
            var was = before.GetValueOrDefault(handler.Name);
            // The event object by its key when the read has it; else the action's property of that name (FlowApply, _event).
            var target = was is { Key.Length: > 0 } ? Ref(was.Key) : actionRef;
            var first = Ops.Count;
            handler.Key = was?.Key ?? "";
            Values(handler, was, target);
            Arguments(handler, was, target, false);
            if (target == actionRef) foreach (var op in Ops.Skip(first)) op["_event"] = handler.Name;
        }
        foreach (var gone in before.Values.Where(b => !now.Items.Any(i => i.Role == "event" && i.Name == b.Name))) {
            var op = Op("set", ("target", gone.Key.Length > 0 ? Ref(gone.Key) : actionRef), ("prop", "Destination"));
            op["value"] = null;
            if (gone.Key.Length == 0) op["_event"] = gone.Name;
            Touched.Add(now.Key);
        }
    }

    private void Arguments(FlowItem now, FlowItem? old, string target, bool optional)
    {
        var before = old?.Items.Where(i => i.Role == "argument").ToDictionary(i => i.Name, i => i.Prop("Value") ?? "", StringComparer.Ordinal) ?? [];
        var after = now.Items.Where(i => i.Role == "argument").ToDictionary(i => i.Name, i => i.Prop("Value") ?? "", StringComparer.Ordinal);
        foreach (var name in after.Keys.Union(before.Keys).ToList()) {
            var value = after.GetValueOrDefault(name, "");
            if (!optional && value == before.GetValueOrDefault(name, "")) continue;
            if (!optional && before.TryGetValue(name, out var was) && ByRename(was) == value) { if (now.Key.Length > 0) Touched.Add(now.Key); continue; }
            if (optional && value.Length == 0 && !before.ContainsKey(name)) continue;
            var op = Op("set", ("target", target + "/arg:" + name), ("prop", "Value"), ("value", value));
            // The arguments of one call are written in its parameters' order (FlowApply): a generic parameter (ListAppend's
            // Element) takes its type from an earlier one (List).
            op["_argOf"] = target;
            if (optional) op["_optional"] = true;
            if (now.Key.Length > 0) Touched.Add(now.Key);
        }
    }

    // The arguments of a SQL or JavaScript node bind its own parameters by name: a parameter the text renames (the rename verb,
    // written first) keeps its argument under the new name, so the read's node is compared with its arguments renamed the same
    // way (else the old name would be written empty, an argument the node no longer has).
    private static FlowItem? Rebound(FlowItem now, FlowItem? old)
    {
        if (old == null || now.Kind is not ("SQLNode" or "JavaScriptNode")) return old;
        var names = now.Items.Where(p => p.Role is "in" or "out" && !IsNew(p.Key)).GroupBy(p => p.Key).ToDictionary(g => g.Key, g => g.First().Name, StringComparer.Ordinal);
        var renamed = old.Items.Where(p => p.Role is "in" or "out" && names.TryGetValue(p.Key, out var name) && name != p.Name)
            .ToDictionary(p => p.Name, p => names[p.Key], StringComparer.Ordinal);
        if (renamed.Count == 0) return old;
        var copy = old.Clone();
        foreach (var argument in copy.Items.Where(i => i.Role == "argument" && renamed.ContainsKey(i.Name))) argument.Name = renamed[argument.Name];
        return copy;
    }

    // What the rename verbs of this text make of an expression of the read (null when the text renames nothing).
    private string? ByRename(string text)
    {
        if (renames.Count == 0) return null;
        // Every rename at once (names that trade places are each renamed once): through marks.
        for (var i = 0; i < renames.Count; i++) text = FlowEdits.Renamed(text, renames[i].From, "\u0002" + i.ToString(System.Globalization.CultureInfo.InvariantCulture) + "\u0002");
        for (var i = 0; i < renames.Count; i++) text = text.Replace("\u0002" + i.ToString(System.Globalization.CultureInfo.InvariantCulture) + "\u0002", renames[i].To, StringComparison.Ordinal);
        return text;
    }

    private static string Group(FlowItem node, string role) => string.Join("\n", node.Items.Where(i => i.Role == role).Select(Line));

    private static string Line(FlowItem part) => part.Role + " " + part.Kind + " " + FlowSyntax.Json(part.Name) + " "
        + string.Join(" ", part.Props.Select(p => p.Key + "=" + p.Value.Type + FlowSyntax.Json(p.Value.Text))) + " " + string.Join(" ", part.Edges.Select(e => ">" + e.Key + "=" + e.Value));

    // A part group where the model's order means nothing (FlowItem.Canon sorts these roles), in text order.
    private static string Unordered(FlowItem node, string role) =>
        string.Join("\n", node.Items.Where(i => i.Role == role).Select(Line).Order(StringComparer.Ordinal));

    // The parts of a node, by role. Parts have no identity of their own: the equal ones stay as they are, the rest are paired
    // (by position where the order means something, else in the order of the text) and written by `set`; what one side has
    // more of is created or deleted. Arguments are written by the parameter they bind.
    private void Parts(FlowItem now, FlowItem? old)
    {
        var target = Ref(now.Key);
        if (now.Opaque) return;
        var changed = old == null || old.Kind != now.Kind;
        // Arguments: by the parameter they bind. When the call changed, the platform rebinds them: every one is written.
        var callChanged = old != null && now.Kind == "Execute" && now.Prop("Action") != old.Prop("Action");
        Arguments(now, changed ? null : Rebound(now, old), target, callChanged);
        var counter = 0;
        string PartAlias() => IsNew(now.Key) ? now.Key + ".p" + ++counter : prefix + now.Key.Replace('/', '_').Replace('+', '_') + ".p" + ++counter;
        void Pair(string role, bool ordered, Action<FlowItem, FlowItem, string> update, Action<FlowItem> create, bool deleteFirst = false)
        {
            var olds = changed ? [] : old!.Items.Where(i => i.Role == role).ToList();
            var news = now.Items.Where(i => i.Role == role).ToList();
            if (!changed && (ordered ? Group(now, role) == Group(old!, role) : Unordered(now, role) == Unordered(old!, role))) return;
            Touched.Add(now.Key);
            var pairs = new List<(FlowItem Old, FlowItem New)>();
            List<FlowItem> extraOld, extraNew;
            if (ordered) {
                var common = Math.Min(olds.Count, news.Count);
                for (var i = 0; i < common; i++) pairs.Add((olds[i], news[i]));
                extraOld = olds.Skip(common).ToList(); extraNew = news.Skip(common).ToList();
            } else {
                var rest = olds.ToList(); var unmatched = new List<FlowItem>();
                foreach (var part in news) {
                    var same = rest.FirstOrDefault(o => Line(o) == Line(part));
                    if (same != null) rest.Remove(same); else unmatched.Add(part);
                }
                var common = Math.Min(rest.Count, unmatched.Count);
                for (var i = 0; i < common; i++) pairs.Add((rest[i], unmatched[i]));
                extraOld = rest.Skip(common).ToList(); extraNew = unmatched.Skip(common).ToList();
            }
            if (deleteFirst) foreach (var part in extraOld) Op("delete", ("target", Ref(part.Key)), ("force", true));
            foreach (var (was, part) in pairs) update(was, part, Ref(was.Key));
            if (!deleteFirst) foreach (var part in extraOld) Op("delete", ("target", Ref(part.Key)), ("force", true));
            foreach (var part in extraNew) create(part);
        }
        // A part written again: its values, and its name where it has one.
        void Update(FlowItem was, FlowItem part, string at)
        {
            if (part.Name != was.Name && part.Name.Length > 0) Op("set", ("target", at), ("prop", "Name"), ("value", part.Name));
            Values(part, was, at);
        }
        Pair("assignment", true, Update, part => {
            var alias = PartAlias();
            Op("create", ("parent", target), ("type", "IAssignment"), ("as", alias));
            PartValues(part, alias);
        });
        var conditionOrder = new List<string>();
        var reconnectsConditions = old == null || !now.Items.Where(p => p.Role == "case").Select(p => p.Edges.GetValueOrDefault("Target"))
            .SequenceEqual(old.Items.Where(p => p.Role == "case").Select(p => p.Edges.GetValueOrDefault("Target")));
        Pair("case", true, (was, part, at) => {
            conditionOrder.Add(at);
            Values(part, was, at);
            if (part.Edges.GetValueOrDefault("Target", "") != was.Edges.GetValueOrDefault("Target", "") && part.Edges.GetValueOrDefault("Target") is { Length: > 0 } to)
                Op("link", ("from", at), ("to", Ref(to)));
        }, part => {
            var alias = PartAlias();
            conditionOrder.Add(alias);
            Op("create", ("parent", target), ("type", "ISwitchCondition"), ("as", alias));
            PartValues(part, alias);
            // A condition's order follows its connector: linked at once, in the text's order.
            if (part.Edges.GetValueOrDefault("Target") is { Length: > 0 } to) Op("link", ("from", alias), ("to", Ref(to)));
        });
        // Linking a condition again can move it in the native sequence: the text's order (the priority of the cases) is
        // restored after every case is linked, the ones whose target did not change too.
        for (var i = 0; reconnectsConditions && conditionOrder.Count > 1 && i < conditionOrder.Count; i++)
            if (i == 0) Op("move", ("target", conditionOrder[i]), ("first", true));
            else Op("move", ("target", conditionOrder[i]), ("after", conditionOrder[i - 1]));
        if (now.Kind == "AggregateNode") {
            var sourcesChanged = !changed && Unordered(now, "source") != Unordered(old!, "source");
            // Joins name sources: when the sources change, the old joins go first and the text's joins are written after them.
            if (sourcesChanged) foreach (var part in old!.Items.Where(i => i.Role == "join")) Op("delete", ("target", Ref(part.Key)), ("force", true));
            void Join(FlowItem part, string at)
            {
                foreach (var (name, value) in part.Props) {
                    if (name is "LeftSource" or "RightSource") { var op = Op("set", ("target", at), ("prop", name), ("value", value.Text)); op["_source"] = target; }
                    else Set(at, name, value);
                }
            }
            Pair("source", false, (was, part, at) => {
                if (part.Name != was.Name) Op("set", ("target", at), ("prop", "Name"), ("value", part.Name));
                if (part.Prop("Source") != was.Prop("Source")) { var op = Op("set", ("target", at), ("prop", "Source"), ("value", part.Prop("Source") ?? "")); op["_ref"] = "Source"; }
            }, part => {
                var alias = PartAlias();
                var create = Op("create", ("parent", target), ("type", "IAliasedSource"), ("name", part.Name), ("as", alias),
                    ("args", new JsonObject { ["dataSource"] = part.Prop("Source") ?? "" }));
                create["_ref"] = "args.dataSource";
            });
            if (sourcesChanged) {
                foreach (var part in now.Items.Where(i => i.Role == "join")) { var alias = PartAlias(); Op("create", ("parent", target), ("type", "IJoin"), ("as", alias)); Join(part, alias); }
            } else Pair("join", false, (was, part, at) => Join(part, at), part => { var alias = PartAlias(); Op("create", ("parent", target), ("type", "IJoin"), ("as", alias)); Join(part, alias); }, deleteFirst: true);
            if (changed || sourcesChanged || now.Prop("MasterSource") != old!.Prop("MasterSource")) {
                if (now.Prop("MasterSource") is { } master) { var op = Op("set", ("target", target), ("prop", "MasterSource"), ("value", master)); op["_source"] = target; Touched.Add(now.Key); }
            }
            var filtersChanged = changed || Unordered(now, "filter") != Unordered(old!, "filter");
            Pair("filter", false, Update, part => Op("create", ("parent", target), ("type", "IFilter"), ("args", new JsonObject { ["condition"] = part.Prop("Condition") ?? "" })));
            Pair("group", false, Update, part => { var alias = PartAlias(); Op("create", ("parent", target), ("type", "IGroupByAttribute"), ("name", part.Name.Length > 0 ? part.Name : null), ("as", alias)); PartValues(part, alias); });
            Pair("agg", false, Update, part => { var alias = PartAlias(); Op("create", ("parent", target), ("type", "IAggregateAttribute"), ("name", part.Name), ("as", alias)); PartValues(part, alias); });
            Pair("calc", false, Update, part => { var alias = PartAlias(); Op("create", ("parent", target), ("type", "ICalculatedAttribute"), ("name", part.Name), ("as", alias)); PartValues(part, alias); });
            Pair("sort", true, Update, part => { var alias = PartAlias(); Op("create", ("parent", target), ("type", "ISort"), ("as", alias)); PartValues(part, alias); });
            // The Studio renames an aggregate that follows its own pattern when a source or filter arrives: the name again.
            if (now.Name.Length > 0 && (changed || sourcesChanged || filtersChanged))
                Op("set", ("target", target), ("prop", "Name"), ("value", now.Name));
        }
        Pair("output", false, (was, part, at) => {
            var op = Op("set", ("target", at), ("prop", "EntityOrStructure"), ("value", part.Prop("EntityOrStructure") ?? ""));
            op["_ref"] = "EntityOrStructure";
        }, part => {
            var alias = PartAlias();
            var create = Op("create", ("parent", target), ("type", "ISQLOutput"), ("name", SqlOutputName(now, part)), ("as", alias),
                ("args", new JsonObject { ["entityOrStructure"] = part.Prop("EntityOrStructure") ?? "" }));
            create["_ref"] = "args.entityOrStructure";
        });
    }

    // The SQL header declares a record type, while the expressions name its output member. The old writer always
    // called that member List, making a new text that reads Q.List.Current.RowType invalid. Respect an unambiguous
    // reference to the declared type's name; preserve the legacy List member when it is referenced or no member is read.
    // Existing output parts keep their names (the update above changes only EntityOrStructure).
    private string SqlOutputName(FlowItem node, FlowItem output)
    {
        var type = output.Prop("EntityOrStructure") ?? "";
        var name = type[(type.LastIndexOf('.') + 1)..];
        if (!FlowSyntax.IsIdentifier(name) || name == "List") return "List";
        static IEnumerable<string> Expressions(FlowItem item) => item.Props.Values.Where(p => p.Type == 'e').Select(p => p.Text)
            .Concat(item.Items.SelectMany(Expressions));
        var expressions = Expressions(Expected).ToList();
        bool FromThisSql(string source)
        {
            while (source.StartsWith('(') && FlowSyntax.Scan(source, 1, [")"]) == source.Length - 1)
                source = source[1..^1].Trim();
            return string.Equals(source, node.Name + ".List", StringComparison.OrdinalIgnoreCase)
                || string.Equals(source, node.Name + ".List.Current", StringComparison.OrdinalIgnoreCase);
        }
        var mappings = FlowMapping.MappingsOf(Expected).Where(mapping => FromThisSql(mapping.Source)).ToList();
        bool Reads(string member) => expressions.Any(expression => FlowEdits.Renamed(expression,
            node.Name + ".List.Current." + member, "\u0001") != expression)
            || mappings.Any(mapping => mapping.Fields.Any(field => FlowEdits.Renamed(field.Value, member, "\u0001") != field.Value));
        return Reads(name) && !Reads("List") ? name : "List";
    }

    private void PartValues(FlowItem part, string alias)
    {
        foreach (var (name, value) in part.Props) Set(alias, name, value);
    }

    private void Edges(FlowItem now, FlowItem? old)
    {
        var target = Ref(now.Key);
        var before = old?.Edges ?? new SortedDictionary<string, string>(StringComparer.Ordinal);
        foreach (var edge in now.Edges.Keys.Union(before.Keys).ToList()) {
            var to = now.Edges.GetValueOrDefault(edge, "");
            if (old != null && to == before.GetValueOrDefault(edge, "")) continue;
            if (old == null && to.Length == 0) continue;
            Touched.Add(now.Key);
            if (edge == "Attached") {
                var op = Op("link", ("from", target), ("to", to.Length > 0 ? Ref(to) : target));
                op["_attach"] = to.Length > 0 ? "attach" : "detach";
                continue;
            }
            if (to.Length == 0) { var unset = Op("set", ("target", target), ("prop", edge)); unset["value"] = null; continue; }
            var link = Op("link", ("from", target), ("to", Ref(to)));
            if (edge != "Target") link["connector"] = edge;
        }
    }
}

// The fresh ids the parser gives the elements written without one (FlowParser.FreshPrefix).
internal static class FlowParserIds
{
    public const string Fresh = FlowParser.FreshPrefix;
}
