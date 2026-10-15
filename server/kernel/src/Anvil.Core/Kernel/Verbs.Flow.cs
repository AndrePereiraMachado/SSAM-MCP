using System.Text.Json.Nodes;
using Anvil.Reading;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// The logic op's text form (stage LG2 of the text plan): {"op":"logic","data":{"flow": text | [text | {text, basedOn}]}}.
/// Each text is one action as ssam-flow/1 (the text ssam_map view "flow" reads), edited. The session reads the action as it
/// is now, prints it (the ids of the read), parses the text, and FlowDiff turns the difference into raw verbs (rename, set,
/// create, link, delete, move) over the same keys; a text without @key creates a module action. Then:
/// <list type="bullet">
/// <item>values are written as the text has them (verbatim: no expression rewrite, no code formatting, no Max. Records
/// filled in): the text is the source;</item>
/// <item>references are the names the reader writes (an action through its producer, "(System).ListAppend"), resolved back
/// to the one element that has that name for that property, the closest to the action when several do;</item>
/// <item>new or structurally changed flows use the shared layout engine at the end of the apply;
/// value-only edits preserve the existing positions;</item>
/// <item>the action is read again and must be the edited text: a value the platform changed is written again (settle), and
/// what still differs refuses the job (FLOW_NOT_EXACT). A new element may keep the Studio's defaults the text left out
/// (reported in defaults).</item>
/// </list>
/// Refusals come once, with every problem of every text (FlowDiff), before anything is written.
/// </summary>
public sealed partial class ModelSession
{
    // Values are written as given (no expression rewrite, no code formatting): set while a flow text is applied.
    private bool _verbatim;
    private int _flowTexts;
    private Dictionary<string, List<IObjectSignature>>? _flowDisplay;
    private Dictionary<string, List<IObjectSignature>>? _flowCallees;
    // While a logic op's texts are planned: the names a client action a fix creates may not take, and whether the op carries
    // the escape of QUERY_IN_LOOP (allowQueryInLoop).
    private Func<string, bool>? _flowActionTaken;
    private bool _flowAllowQueryInLoop;
    /// <summary>The action as an earlier read had it, while a text writes it back (the undo of FlowBattery): its JavaScript
    /// nodes come back as they were (FlowDiff.Compute restoredFrom). Never set by an op.</summary>
    internal FlowItem? FlowRestore;

    /// <summary>A text of a logic op the apply wrote: the op, the text's pointer under data, the text, the action's key and every
    /// id of the text with the model key of its element (the patch round finds the nodes a fix wrote by them).</summary>
    internal sealed record FlowTextWritten(int Op, string Pointer, string Text, string ActionKey, IReadOnlyDictionary<string, string> Keys);
    internal readonly List<FlowTextWritten> FlowTextsWritten = [];

    // Scoped to one Apply logic op. The full text list and its indices remain intact for patches and diagnostics.
    private Blocked? _flowBlocked;
    private Action<string, int, string>? _flowDependencySkipped;

    private JsonNode FlowOp(JsonObject op)
    {
        var data = op["data"]!.AsObject();
        var unknown = data.Select(p => p.Key).Where(k => k is not ("flow" or "basedOn")).ToList();
        if (unknown.Count > 0)
            throw new KernelRefusalException("FLOW_SYNTAX", "logic: the text form takes data.flow (one text, or a list of texts or {text, basedOn}) and data.basedOn; not " + string.Join(", ", unknown),
                new JsonArray(JobPreflight.PublicProblem(JobPreflight.Problem(null, "/data", "FLOW_SYNTAX", "error", "unknown keys " + string.Join(", ", unknown) + " beside data.flow",
                    "keep only flow (and basedOn)"))));
        var texts = FlowTextForm.Texts(data);
        var excluded = new Dictionary<int, (string Name, int Op)>();
        if (_flowBlocked != null) {
            // Mark the headers first, then scan again: a caller may precede the skipped action it calls.
            bool changed;
            do {
                changed = false;
                for (var i = 0; i < texts.Count; i++) {
                    if (excluded.ContainsKey(i) || _flowBlocked.UsedByText(texts[i].Text) is not { } used) continue;
                    excluded.Add(i, used);
                    _flowBlocked.MarkFlow(texts[i].Text, used.Op);
                    changed = true;
                }
            } while (changed);
            foreach (var (index, used) in excluded.OrderBy(e => e.Key))
                _flowDependencySkipped?.Invoke(texts[index].Pointer, used.Op, used.Name);
        }
        // Every text is read and compared first: one refusal with every problem of every text, before anything is written.
        var problems = new List<(string Pointer, FlowProblem Problem)>();
        var plans = new List<FlowPlan>();
        var editedBy = new Dictionary<string, string>(StringComparer.Ordinal);
        var created = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        // The names a client action a fix creates may not take: the module's actions, the actions the texts of this op name and
        // the ones an earlier text's fix already took.
        var reserved = FlowTextForm.ActionNames(texts);
        _flowAllowQueryInLoop = QueryInLoopRule.Allowed(op, out _) != null;
        // Every action of the module (a screen's and a block's too, which the Studio counts in the scope of a new client action,
        // and the references'), screen, block and flow: a name one of them has is taken (e1 of the review: a script moved into
        // a client action named after a screen action of the same screen was renamed by the Studio, NAME_COLLISION).
        HashSet<string>? inModule = null;
        _flowActionTaken = name => reserved.Contains(name) || (inModule ??= ScopeNames()).Contains(name);
        for (var index = 0; index < texts.Count; index++) {
            var (text, basedOn, pointer) = texts[index];
            if (excluded.ContainsKey(index)) { plans.Add(new(null, null, null, null, null, [])); continue; }
            var plan = PlanFlowText(text, basedOn, FlowDiff.AliasPrefix + "0.");
            plans.Add(plan);
            problems.AddRange(plan.Problems.Select(p => (pointer, p)));
            foreach (var extra in plan.Problems.SelectMany(p => p.Added ?? []))
                foreach (var name in FlowTextForm.ActionNames([(extra, null, "")])) reserved.Add(name);
            if (plan.Edited is not { } edited) continue;
            if (plan.Baseline is { } baseline && !editedBy.TryAdd(baseline.Key, pointer))
                problems.Add((pointer, new("FLOW_KEY_TWICE", "the action " + baseline.Name + " is edited by two texts of this op (" + editedBy[baseline.Key] + " and " + pointer + ")",
                    baseline.Key, "send one text per action")));
            // A new action's name is unique in the module (a module action) or in its owner (a screen, block or data action).
            var createdName = edited.Owner.Length > 0 ? edited.Owner + "." + edited.Name : edited.Name;
            var createdScope = edited.Owner.Length > 0 ? createdName : Preflight.ActionNameRules.Scope(edited.Kind) + ":" + createdName;
            if ((plan.Baseline == null || plan.Shell) && edited.Name.Length > 0 && !created.TryAdd(createdScope, pointer))
                problems.Add((pointer, new("FLOW_ACTION_NAME_TAKEN", "two texts of this op create an action named " + createdName + " (" + created[createdScope] + " and " + pointer + ")",
                    null, "give each new action its own name, or send one text")));
        }
        _flowActionTaken = null;
        if (problems.Count > 0) {
            // The patch of the op: every text with the certain fixes of its problems, the new action texts they need after them
            // (one patch for the whole op, the same on each problem it fixes: applying it twice writes the same job).
            var corrected = plans.Select(p => p.Problems.FirstOrDefault(q => q.Corrected != null)?.Corrected).ToList();
            var added = plans.SelectMany(p => p.Problems.FirstOrDefault(q => q.Corrected != null)?.Added ?? []).ToList();
            var rebased = plans.Select(p => p.RebasedOn).ToList();
            throw Refusal(problems, corrected.Any(c => c != null) ? FlowTextForm.Patch(data, texts, corrected, added, rebased) : null);
        }
        var results = new JsonNode?[texts.Count];
        // Texts that trade the names of two actions (A -> B and B -> A), or one that takes the name another text gives up: the
        // action whose name another text takes goes through a free name first, and its text reads it with the name it was read
        // with (the 24.1 fixes, o-c2: the second rename clashed with the first, uncoded). Listed in renamedThrough.
        var through = new JsonArray();
        var renaming = plans.Where(p => p.Action != null && p.Baseline != null && !p.Shell && p.Edited is { Name.Length: > 0 } e && !string.Equals(e.Name, p.Baseline.Name, StringComparison.Ordinal)).ToList();
        foreach (var holder in renaming) {
            if (!renaming.Any(other => !ReferenceEquals(other, holder) && string.Equals(other.Edited!.Name, holder.Baseline!.Name, StringComparison.OrdinalIgnoreCase))) continue;
            var key = holder.Action!.ObjectKey!.ToString()!;
            var taken = ScopeNames();
            foreach (var p in renaming) taken.Add(p.Edited!.Name);
            var free = FlowDiff.Numbered(holder.Baseline!.Name + "Renamed", taken.Contains);
            ApplyOne(new JsonObject { ["op"] = "rename", ["target"] = "@" + key, ["name"] = free });
            _flowNameAsRead[key] = holder.Baseline.Name;
            through.Add(new JsonObject { ["action"] = "@" + key, ["from"] = holder.Baseline.Name, ["through"] = free, ["to"] = holder.Edited!.Name });
        }
        // A text the read back refuses (a mapping the platform keeps in another form, FLOW_NOT_EXACT) does not stop the others:
        // every text is written and read back, and the op refuses once with the problems of each (nothing of it is kept).
        var refusals = new List<KernelRefusalException>();
        try {
            foreach (var i in CreationOrder(plans)) {
                if (excluded.ContainsKey(i)) continue;
                try { results[i] = ApplyFlowText(texts[i].Text, texts[i].BasedOn, texts[i].Pointer); }
                catch (KernelRefusalException error) when (error.Problems is { Count: > 0 }) { refusals.Add(error); }
                catch (Exception) when (refusals.Count > 0) { break; }
            }
        } finally { _flowNameAsRead.Clear(); }
        if (refusals.Count == 1) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(refusals[0]).Throw();
        if (refusals.Count > 1)
            throw new KernelRefusalException(refusals[0].Code, string.Join(Environment.NewLine, refusals.Select(r => r.Message)),
                new JsonArray(refusals.SelectMany(r => r.Problems!).Select(p => p?.DeepClone()).ToArray()));
        var answer = new JsonObject { ["flow"] = new JsonArray(results) };
        if (through.Count > 0) answer["renamedThrough"] = through;
        return answer;
    }

    // While the texts of an op are written: an action renamed through a free name (FlowOp), by key, and the name its text read.
    private readonly Dictionary<string, string> _flowNameAsRead = new(StringComparer.Ordinal);

    // The read and the diff of one text, before anything is written: the problems are every reason it cannot be written.
    // Merged: the note of the three-way merge when the text was written on an older read (FlowMerge), else null.
    // Shell: the text names a screen action without @key that an html document of this job made as a shell (its name and
    // parameters, so the events bind); the text fills it in place, keeping its key and its parameters.
    // RebasedOn: the textSha of the read a merged text is written on (the action now): its corrections go with that basedOn.
    private sealed record FlowPlan(FlowItem? Edited, IObjectSignature? Action, FlowItem? Baseline, FlowDocument? Read, FlowDiff? Diff, List<FlowProblem> Problems,
        JsonObject? Merged = null, bool Shell = false, string? RebasedOn = null);

    /// <summary>The reads an edit written on an older read is merged with, by textSha (the merge battery keeps them in memory).
    /// Null: the store (ModuleIndexStore.Default), where ssam_map view flow keeps every action it serves.</summary>
    public Func<string, FlowReading?>? FlowReadings { get; set; }

    private FlowReading? FlowReadingOf(string textSha) =>
        FlowReadings != null ? FlowReadings(textSha) : ModuleIndexStore.Default()?.LoadFlowReading(textSha);

    // The screen actions an html document of this job made as shells for a text of a logic op after it (DocumentShells),
    // by key, until the text fills them.
    private readonly HashSet<string> _flowShells = new(StringComparer.Ordinal);

    // The problem of a line a rule of the compiler refuses at the parse (`AGG Total=Count()`): its code and fix, and the corrected
    // text when the fix is certain (the identifier of the one source, as the model names it) and that text, planned again on
    // this module, has no problem at all.
    private FlowProblem RuleProblem(FlowRuleFormatException rule, string text, string? basedOn, string prefix)
    {
        var problem = new FlowProblem(rule.Code, rule.Message, null, rule.Fix);
        // ODC: the text does not write a grouped aggregate (it reads back opaque), so the parse offers no patch there.
        if (rule.Replace is not { Length: > 0 } from || rule.With is not { } with || rule.Entity is not { Length: > 0 } entity) return problem;
        var at = text.IndexOf(from, StringComparison.Ordinal);
        if (at < 0 || text.IndexOf(from, at + 1, StringComparison.Ordinal) >= 0) return problem;
        if (new ModelFlowTypes(this, null).IdentifierOf(entity) is not { } identifier) return problem;
        var to = with.Replace("{identifier}", identifier, StringComparison.Ordinal);
        var corrected = text[..at] + to + text[(at + from.Length)..];
        try { if (PlanFlowText(corrected, basedOn, prefix).Problems.Count > 0) return problem; }
        catch { return problem; }
        return problem with { Fix = "write " + to + " (Count counts the rows of each group by the identifier of its source)", Corrected = corrected };
    }

    private FlowPlan PlanFlowText(string text, string? basedOn, string prefix)
    {
        var problems = new List<FlowProblem>();
        FlowItem edited;
        try { edited = ModuleFlow.Read(text); EmptyMappings(edited); }
        catch (FormatException error) {
            // A line the grammar reads and a rule of the compiler refuses (a column that reads no attribute) keeps its code and fix,
            // and the corrected text when the fix is certain and that text has no problem at all.
            if (error is FlowRuleFormatException rule) problems.Add(RuleProblem(rule, text, basedOn, prefix));
            // Every line the grammar refuses is its own problem (VisitaCerta).
            else foreach (var message in error is FlowSyntaxException all ? all.Errors : [error.Message])
                problems.Add(new("FLOW_SYNTAX", message, null, "write the line in the ssam-flow/1 grammar (docs/TEXTO-LOGICA.md)"));
            return new(null, null, null, null, null, problems);
        }
        var reader = new KernelModelReader();
        var root = (IObjectSignature)_es;
        IObjectSignature? action = null;
        FlowItem? baseline = null;
        FlowDocument? read = null;
        FlowOwnerRef? owner = null;
        // The screen or block a new screen, block or data action is born under (what the model says of its scope).
        IObjectSignature? under = null;
        var shell = false;
        if (edited.Key.Length == 0 && FlowOwners.Owned(edited.Kind) && edited.Owner.Length > 0) {
            // A new screen, block or data action: under the one owner its header names.
            var found = FlowOwners.Find(reader, root, edited.Owner);
            if (found.Count != 1) {
                problems.Add(found.Count == 0
                    ? new("FLOW_OWNER_UNKNOWN", "the header names the owner " + edited.Owner + ", and the module has no screen, block or email of that name"
                        + (NameSuggestions.Closest(edited.Owner[(edited.Owner.LastIndexOf('/') + 1)..], FlowOwners.Names(reader, root), 3) is { Count: > 0 } near ? " (nearest: " + string.Join(", ", near) + ")" : ""),
                        null, "name an owner of the module; a screen this job creates comes first (its html op before this logic op)")
                    : new("FLOW_OWNER_AMBIGUOUS", "the owner " + edited.Owner + " names " + found.Count + " elements: " + string.Join(", ", found.Take(4).Select(o => FlowOwners.PathOf(reader, root, o))),
                        null, "write the owner's path: " + FlowPrinter.Labels[edited.Kind] + " " + FlowOwners.PathOf(reader, root, found[0]) + "." + edited.Name));
                return new(edited, null, null, null, null, problems);
            }
            var parent = found[0];
            under = parent;
            // A Reactive or Mobile screen or block: its screen actions are client actions, and it holds data actions. A
            // Traditional owner's actions are edited by their text but not born from one (decision 7 of the plan: Traditional
            // Web comes after the Reactive texts are proven, as the html op refuses it).
            var mobile = Implements(parent, "IMobileScreen") || Implements(parent, "IMobileBlock");
            if (!mobile) {
                problems.Add(new("FLOW_OWNER_KIND", "a new " + FlowPrinter.Labels[edited.Kind] + " is born from its text under a Reactive or Mobile screen or block; " + edited.Owner
                    + " is a " + reader.KindOf(parent) + " (Traditional Web is not written by text)", null,
                    "name a Reactive or Mobile screen or block, or create the Traditional action with the logic op (kind screen, owner)"));
                return new(edited, null, null, null, null, problems);
            }
            var taken = parent.Children.OfType<IObjectSignature>().FirstOrDefault(c => ModuleFlow.ActionKinds.Contains(reader.KindOf(c))
                && string.Equals(reader.NameOf(c), edited.Name, StringComparison.OrdinalIgnoreCase));
            if (taken != null && !(_flowShells.Contains(taken.ObjectKey!.ToString()!) && reader.KindOf(taken) == edited.Kind)) {
                problems.Add(NameTaken(reader, taken, edited.Owner + " has"));
                return new(edited, null, null, null, null, problems);
            }
            edited.Owner = FlowOwners.Text(reader, root, parent);
            if (taken != null) {
                // The shell of an html document of this job: the text fills it (its key, its Start and its parameters stay).
                action = taken; shell = true;
                baseline = new FlowExtractor<IObjectSignature>(reader, root).Action(taken, out _);
                read = ModuleFlow.Print(baseline);
                var idOf = read.Keys.ToDictionary(p => p.Value, p => p.Key, StringComparer.Ordinal);
                var kept = new HashSet<string>(StringComparer.Ordinal);
                foreach (var parameter in edited.Items.Where(i => i.Role is "in" or "out" or "local"))
                    if (baseline.Items.FirstOrDefault(p => p.Role == parameter.Role && string.Equals(p.Name, parameter.Name, StringComparison.OrdinalIgnoreCase)) is { } same
                        && idOf.TryGetValue(same.Key, out var id) && kept.Add(id)) parameter.Key = id;
                edited.Key = baseline.Key;
            } else owner = new("@" + parent.ObjectKey, Web: false);
        } else if (edited.Key.Length > 0) {
            try { action = Resolve("@" + edited.Key) as IObjectSignature; } catch (KeyNotFoundException) { }
            if (action == null || !ModuleFlow.ActionKinds.Contains(reader.KindOf(action))) {
                problems.Add(new("FLOW_KEY_FOREIGN", "the header names @" + edited.Key + ", which is not an action of this module", edited.Key,
                    "read the action (ssam_map view flow) and edit that text; a new action is written without @key"));
                return new(edited, null, null, null, null, problems);
            }
            baseline = new FlowExtractor<IObjectSignature>(reader, (IObjectSignature)_es).Action(action, out var found);
            // An action the op renamed through a free name reads as its text read it (FlowOp).
            if (_flowNameAsRead.TryGetValue(baseline.Key, out var asRead)) baseline.Name = asRead;
            read = ModuleFlow.Print(baseline);
            var check = found.Count == 0 && read.Unprintable.Count == 0 ? ModuleFlow.Check(baseline, read) : null;
            if (found.Count > 0 || read.Unprintable.Count > 0 || check != null) {
                problems.Add(new("FLOW_NOT_REPRESENTED", "the action " + baseline.Name + " is not a fixed point of its text ("
                    + string.Join("; ", found.Concat(read.Unprintable).Append(check ?? "").Where(p => p.Length > 0).Take(3)) + "): it is read, never written back from text", edited.Key,
                    "change it with the logic op (replace) or the raw verbs"));
                return new(edited, action, baseline, read, null, problems);
            }
            var sha = ModuleFlow.TextSha(read.Text);
            if (basedOn == null) {
                // The ids of the text are of a read: without basedOn they would be read against the action now, and what the Studio
                // changed since would be undone. Refused with the action now, as a ready edit (kept as a read: an edit of it
                // that arrives after the action changed again is merged).
                KeepFlowReading(baseline, read);
                problems.Add(new("FLOW_BASE_REQUIRED", "the header names @" + edited.Key + " (an action of a read) and the text has no basedOn: its ids are of that read, "
                    + "and what changed in the Studio since cannot be told from what the text changes", edited.Key,
                    "send the text with basedOn, the textSha of the read it was written on (ssam_map view flow); data.edit is the action now (textSha " + sha + "), ready to edit and send", read.Text) {
                    Data = new JsonObject { ["edit"] = new JsonObject { ["text"] = read.Text, ["basedOn"] = sha } } });
                return new(edited, action, baseline, read, null, problems);
            }
            if (!string.Equals(basedOn, sha, StringComparison.OrdinalIgnoreCase)) {
                // The action changed since the read the text was written on: merged three ways with that read (FlowMerge) when the
                // store keeps it; otherwise refused with the current text, as a ready edit.
                var reading = FlowReadingOf(basedOn);
                var why = reading == null ? "that read is not kept here (an older read, or another store), so it cannot be merged three ways"
                    : reading.ActionKey != edited.Key ? "the read basedOn names is of another action (@" + reading.ActionKey + ")" : null;
                FlowMerge.Result? merge = null;
                if (why == null) {
                    merge = FlowMerge.ThreeWay(reading!, baseline, read, text, (source, side) => MappingScopeOf(source, side));
                    if (merge.Problems.Count > 0) { problems.AddRange(merge.Problems); return new(edited, action, baseline, read, null, problems); }
                    if (merge.Text == null) why = (merge.Failure ?? "the merge could not be written as text") + ", so it is not merged";
                }
                if (why != null) {
                    KeepFlowReading(baseline, read);
                    problems.Add(new("FLOW_BASE_CHANGED", "the action changed since the read this text edits (basedOn " + basedOn + ", now " + sha + ") and " + why
                        + "; its ids may name other elements now", edited.Key, "edit the text below (textSha " + sha + ") and send it with basedOn " + sha + " (data.edit: that edit, ready)", read.Text) {
                        Data = new JsonObject { ["edit"] = new JsonObject { ["text"] = read.Text, ["basedOn"] = sha } } });
                    return new(edited, action, baseline, read, null, problems);
                }
                var mergedText = merge!.Text!;
                var note = new JsonObject { ["merge"] = "three-way", ["basedOn"] = basedOn, ["now"] = sha, ["studio"] = merge.Kept,
                    ["note"] = "the action changed since the read: the text was merged with what changed (base = that read, theirs = the action now); what only the Studio changed stays" };
                if (merge.Conflicts.Count > 0) {
                    note["conflicts"] = new JsonArray(merge.Conflicts.Select(c => (JsonNode)c.DeepClone()).ToArray());
                    note["rule"] = "a change of the same element in the text and in the Studio keeps the delivery's version";
                }
                try { edited = ModuleFlow.Read(mergedText); EmptyMappings(edited); }
                catch (FormatException error) {
                    problems.Add(new("FLOW_BASE_CHANGED", "the action changed since the read this text edits (basedOn " + basedOn + ", now " + sha + ") and the merged text does not parse ("
                        + error.Message + ")", edited.Key, "edit the text below (textSha " + sha + ") and send it with basedOn " + sha, read.Text) {
                        Data = new JsonObject { ["edit"] = new JsonObject { ["text"] = read.Text, ["basedOn"] = sha } } });
                    return new(edited, action, baseline, read, null, problems);
                }
                // The rules of the owner judge the merged text as they judge a text (the escape of QUERY_IN_LOOP, the names a moved
                // script may not take, what the module says), and its certain fixes are written into the merged text: that text is
                // written on the action now, so the patch sends it with basedOn of now (RebasedOn), and it is not merged again.
                // The elements of the read the merge writes again (new keys) are the action's own: never judged as new ones.
                var mergedDiff = FlowDiff.Compute(baseline, read.Keys, edited, read.Text, prefix, mergedText,
                    _flowActionTaken ?? (name => ScopeNames().Contains(name)), _flowAllowQueryInLoop, FlowRestore, new ModelFlowTypes(this, action), rewritten: merge.Rewritten);
                // A rule the merged text breaks names its ids: the problem carries that text.
                var mergedProblems = mergedDiff.Problems.Concat(RenameCaptures(baseline, mergedDiff, read)).ToList();
                mergedProblems.AddRange(EditedCursors(mergedText, edited, baseline, read, mergedProblems.Any(p => p.Corrected != null)));
                problems.AddRange(mergedProblems.Select(p => p with { Data = new JsonObject { ["merged"] = mergedText } }));
                return new(edited, action, baseline, read, mergedDiff, problems, note, RebasedOn: sha);
            }
            // The owner the header names is the action's (the read's text writes it as FlowOwners.Text; a path or another
            // case of the same owner is the same): another owner would move the action (FlowDiff refuses it).
            if (edited.Owner.Length > 0 && FlowOwners.Owned(baseline.Kind) && action.Parent is IObjectSignature parent
                && FlowOwners.Find(reader, root, edited.Owner).Any(o => ReferenceEquals(o, parent)))
                edited.Owner = baseline.Owner;
        } else if (!FlowOwners.Owned(edited.Kind) && ModuleAction(edited.Name, edited.Kind) is { } taken) {
            // A text without @key creates an action: never a second one beside an action of the same name (OutSystems names
            // have no case). The text of the one there is the patch: edit it and keep its ids.
            problems.Add(Implements(taken, "IEntityActionSignature")
                ? new("NAME_COLLISION", "new action '" + edited.Name + "' collides with " + reader.KindOf(taken) + " '" + reader.NameOf(taken) + "' in the module", null,
                    Anvil.Core.Preflight.ActionNameRules.Fix)
                : NameTaken(reader, taken, "the module has"));
            return new(edited, null, null, null, null, problems);
        }
        // With the text: the problems whose fix is certain carry the corrected text, checked against the same read; what the
        // text does not declare (a list of the screen, a screen aggregate, the order of a record) the model says. A new screen,
        // block or data action is created under the owner the header names (resolved above).
        var diff = FlowDiff.Compute(baseline, read?.Keys ?? new Dictionary<string, string>(), edited, read?.Text, prefix, text,
            _flowActionTaken ?? (name => ScopeNames().Contains(name)), _flowAllowQueryInLoop, FlowRestore, new ModelFlowTypes(this, action, under), owner);
        problems.AddRange(diff.Problems);
        if (baseline != null && read != null) problems.AddRange(RenameCaptures(baseline, diff, read));
        if (baseline != null && read != null) problems.AddRange(EditedCursors(text, edited, baseline, read, problems.Any(p => p.Corrected != null)));
        return new(edited, action, baseline, read, diff, problems, Shell: shell);
    }

    // FLOW_MAPPING_CURSOR in an edit of a read: a mapping value the text writes (new, or changed from the read) that reads its
    // list's Current (`L mapTo { F: L.Current.X }`) would map every item to the list's cursor. A value as the read has it is the
    // Studio's and stays as it is. The patch is the text with each such value relative to the item (FlowTextNormalizer, the
    // rewrite a new action gets as FLOW_MAPPING_RELATIVE), when every one of them has that form and no other fix of the text
    // is the patch; a value that reads the item whole has none. Kept is decided by content, never by place (re-check of
    // 2026-10-12, probes E2, E3 and E5: an edit that removes, swaps or adds another assignment of the block leaves the
    // Studio's value as it was): an argument of the same name with the same value, an assignment of the same variable with the
    // same value in the read's node of the same key (each assignment of the read once).
    private static List<FlowProblem> EditedCursors(string text, FlowItem edited, FlowItem baseline, FlowDocument read, bool otherFix)
    {
        var values = FlowTextNormalizer.CursorValues(edited);
        if (values.Count == 0) return [];
        var was = baseline.Items.Where(i => i.Role == "node").ToDictionary(i => i.Key, StringComparer.Ordinal);
        var taken = new HashSet<FlowItem>(ReferenceEqualityComparer.Instance);
        bool Kept(FlowTextNormalizer.CursorValue value)
        {
            if (!read.Keys.TryGetValue(value.Node.Key, out var key) || !was.TryGetValue(key, out var node)) return false;
            if (value.Part.Role == "argument")
                return node.Items.FirstOrDefault(p => p.Role == "argument" && p.Name == value.Part.Name)?.Prop("Value") == value.Value;
            var then = node.Items.FirstOrDefault(p => p.Role == "assignment" && !taken.Contains(p)
                && p.Prop("Variable") == value.Part.Prop("Variable") && p.Prop("Value") == value.Value);
            return then != null && taken.Add(then);
        }
        var written = values.Where(v => !Kept(v)).ToList();
        if (written.Count == 0) return [];
        string? corrected = null;
        if (!otherFix && written.All(v => v.Relative != null)) {
            var candidate = FlowTextEdit.Apply(text, FlowTextNormalizer.CursorEdits(text, edited, written));
            try { ModuleFlow.Read(candidate); if (candidate != text) corrected = candidate; } catch (FormatException) { }
        }
        return written.Select(v => new FlowProblem("FLOW_MAPPING_CURSOR", "the mapping " + v.Value + " reads " + v.Source + ".Current, the list's cursor (one item for every item it maps)",
            read.Keys.ContainsKey(v.Node.Key) ? v.Node.Key : null,
            v.Relative != null ? "inside the mapping each value is relative to the item: " + v.Relative
                : "inside `" + v.Source + " mapTo { ... }` each value is relative to the item: write the item's attribute (`Record.Attribute`, or `Record` for a record of the row) where it reads " + v.Source + ".Current")
            { Corrected = corrected }).ToList();
    }

    // A read kept in the store as the base of a next edit (the edit a refusal hands back, the text an action reads as after a
    // text): only in a job (KeepReadings), never where the reads are kept in memory (the merge battery).
    private void KeepFlowReading(FlowItem item, FlowDocument read)
    {
        if (!KeepReadings || FlowReadings != null || ModuleIndexStore.Default() is not { } store) return;
        try { store.SaveFlowReading(new FlowReading(MessageExpectations.Lane, BaseSha256 ?? new string('0', 64), item.Key, item.Kind, item.Name, read.Text, read.Keys)); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException) { }
    }

    // An empty mapping (Source mapTo { }) is the value itself: the conversion the platform makes on its own (ODC keeps it as
    // "Source mapTo {  }", which the reader leaves out; O11 does not parse it). Written as the plain value in both lanes.
    private static void EmptyMappings(FlowItem item)
    {
        foreach (var part in item.Items) {
            if (part.Role is "assignment" or "argument" && part.Props.TryGetValue("Value", out var value) && value.Type == 'e' && FlowMapping.WithoutEmpty(value.Text) is { } plain)
                part.Props["Value"] = new('e', plain);
            EmptyMappings(part);
        }
    }

    // A parameter or local the text renames onto the name of an attribute of the source of a mapping of the action that names it:
    // inside the mapping the source's attributes come first, so the renamed element would be read as that attribute (the
    // text reads back the same and means something else). Refused with a free name (FLOW_RENAME_CAPTURED).
    private List<FlowProblem> RenameCaptures(FlowItem baseline, FlowDiff diff, FlowDocument read)
    {
        var problems = new List<FlowProblem>();
        if (diff.Renamed.Count == 0) return problems;
        var parameters = baseline.Items.Where(i => i.Role is "in" or "out" or "local").ToDictionary(i => "@" + i.Key, StringComparer.Ordinal);
        foreach (var (element, from, to) in diff.Renamed) {
            if (!parameters.TryGetValue(element, out var renamed) || RenameCapture(baseline, from, to) is not { } capture) continue;
            var id = read.Keys.FirstOrDefault(p => p.Value == renamed.Key).Key ?? renamed.Key;
            problems.Add(new("FLOW_RENAME_CAPTURED", "@" + id + " " + renamed.Role + " " + capture.Message, id, capture.Fix));
        }
        return problems;
    }

    /// <summary>Whether renaming the action's parameter or local `from` to `to` would make a mapping of the action read another
    /// element: a field value of a mapping (Source mapTo { Field: value }) that names `from` (the element, not an attribute of
    /// the source of that name) reads `to` as the attribute of the source when the source has one of that name, or may have
    /// (the module could not type the source, and some record of the module has an attribute `to`). The message and the fix
    /// (a free name) of the refusal, or null.</summary>
    internal (string Message, string Fix)? RenameCapture(FlowItem action, string from, string to)
    {
        foreach (var (source, fields) in FlowMapping.MappingsOf(action)) {
            if (!fields.Any(f => FlowEdits.Renamed(f.Value, from, "\u0001") != f.Value)) continue;
            var attributes = SourceAttributes(source, action);
            // A name the typed source has is that attribute: the rename does not touch it.
            if (attributes != null && attributes.Contains(from)) continue;
            var scope = attributes ?? AttributeNames();
            if (!scope.Contains(to)) continue;
            var taken = new HashSet<string>(action.Items.Where(i => FlowItem.Keyed(i.Role)).Select(i => i.Name).Concat(scope), StringComparer.OrdinalIgnoreCase);
            var free = FlowDiff.Numbered(to, taken.Contains);
            return (from + " is renamed " + to + ", and the mapping `" + source + " mapTo { ... }` names " + from + " in a field value: inside a mapping the attributes of its source come first, and "
                + to + (attributes != null ? " is an attribute of `" + source + "`" : " may be one (the module could not type `" + source + "`, and a record of the module has an attribute " + to + ")")
                + ", so the value would read that attribute instead of the renamed element",
                "give it a name no attribute of the source has, e.g. " + free);
        }
        return null;
    }

    /// <summary>What a field value of a mapping reads first (FlowMerge's scope): the attributes of the source as the module types
    /// it, else every attribute name of the module (a superset).</summary>
    private FlowMerge.MappingScope MappingScopeOf(string source, FlowItem action) =>
        SourceAttributes(source, action) is { } exact ? new(exact, true) : new(AttributeNames(), false);

    // Every name an attribute of a record of the module or its references has (entities, structures, the columns of an
    // aggregate) and every source alias: no mapping's source has an attribute outside it.
    private HashSet<string> AttributeNames()
    {
        var reader = new KernelModelReader();
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var element in reader.Walk((IObjectSignature)_es))
            if (!element.WasDeleted && reader.KindOf(element) is var kind && (kind.EndsWith("Attribute", StringComparison.Ordinal) || kind == "AliasedSource")
                && reader.NameOf(element) is { Length: > 0 } name)
                names.Add(name);
        return names;
    }

    // The attribute names of the record a mapping's source reads, typed through the module: a parameter or local of the action
    // of a record or a list of it; an aggregate's row (its sources, columns and groups) or one of its sources; the output of a
    // call node (GetX.Out: the output parameter of the action it calls); the row of a SQL node with one output; and a member of
    // any of those that is a record (Rec.Attribute), the item of a list through .Current or .List. Null when it cannot tell.
    private HashSet<string>? SourceAttributes(string source, FlowItem action)
    {
        var parts = source.Trim().Split('.').Select(p => p.Trim()).ToList();
        if (parts.Count == 0 || parts.Any(p => !FlowSyntax.IsIdentifier(p))) return null;
        static bool Same(string a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);
        static bool Item(string part) => Same(part, "List") || Same(part, "Current");
        var first = parts[0];
        if (action.Items.FirstOrDefault(i => i.Role == "node" && i.Kind == "AggregateNode" && Same(i.Name, first)) is { } aggregate) {
            var rest = parts.Skip(1).SkipWhile(Item).ToList();
            if (rest.Count == 0)
                return aggregate.Items.Where(p => p.Role is "source" or "agg" or "calc" or "group").Select(p => p.Name).Where(n => n.Length > 0).ToHashSet(StringComparer.OrdinalIgnoreCase);
            return aggregate.Items.FirstOrDefault(p => p.Role == "source" && Same(p.Name, rest[0]))?.Prop("Source") is { } entity ? Members(entity, rest.Skip(1)) : null;
        }
        if (action.Items.FirstOrDefault(i => i.Role is "in" or "out" or "local" && Same(i.Name, first)) is { } parameter)
            return parameter.Prop("DataType") is { } type ? Members(type, parts.Skip(1)) : null;
        if (action.Items.FirstOrDefault(i => i.Role == "node" && Same(i.Name, first)) is not { } node || parts.Count < 2) return null;
        if (node.Kind == "SQLNode")
            return Same(parts[1], "List") && node.Items.Where(p => p.Role == "output").ToList() is { Count: 1 } outputs && outputs[0].Prop("EntityOrStructure") is { } row
                ? Members(row, parts.Skip(2)) : null;
        if (node.Kind != "Execute" || node.Prop("Action") is not { } callee) return null;
        IObjectSignature called;
        try { called = Callee(callee, null, node.Prop(FlowRules.CallProperty)); } catch (KernelRefusalException) { return null; }
        var reader = new KernelModelReader();
        var output = reader.ChildrenOf(called).FirstOrDefault(c => reader.KindOf(c).EndsWith("OutputParameter", StringComparison.Ordinal) && Same(reader.NameOf(c), parts[1]));
        return output != null && UiCatalog.TypeName(ModelHost.Prop(output, "DataType")) is { Length: > 0 } outputType ? Members(outputType, parts.Skip(2)) : null;
    }

    // The attributes of the record a type names (an entity or structure of the module or its references, the item of a list),
    // after the members of `path` (each an attribute of a record type; .Current and .List of a list are its item).
    private HashSet<string>? Members(string type, IEnumerable<string> path)
    {
        var reader = new KernelModelReader();
        var record = Record(type);
        foreach (var part in path) {
            if (string.Equals(part, "Current", StringComparison.OrdinalIgnoreCase) || string.Equals(part, "List", StringComparison.OrdinalIgnoreCase)) continue;
            if (record == null) return null;
            var attribute = reader.ChildrenOf(record).FirstOrDefault(c => reader.KindOf(c).EndsWith("Attribute", StringComparison.Ordinal) && string.Equals(reader.NameOf(c), part, StringComparison.OrdinalIgnoreCase));
            record = attribute == null ? null : Record(UiCatalog.TypeName(ModelHost.Prop(attribute, "DataType")));
        }
        return record == null ? null : reader.ChildrenOf(record).Where(c => reader.KindOf(c).EndsWith("Attribute", StringComparison.Ordinal)).Select(reader.NameOf)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        IObjectSignature? Record(string name)
        {
            name = name.Trim();
            if (name.EndsWith(" List", StringComparison.Ordinal)) name = name[..^5].Trim();
            return name.Length == 0 ? null : reader.Walk((IObjectSignature)_es).FirstOrDefault(e => !e.WasDeleted && (Implements(e, "IStructureSignature") || Implements(e, "IEntitySignature"))
                && string.Equals(reader.DisplayOf(e), name, StringComparison.Ordinal));
        }
    }

    // FLOW_ACTION_NAME_TAKEN: the text of the action already there is the patch (edit it and keep its ids).
    private FlowProblem NameTaken(KernelModelReader reader, IObjectSignature taken, string where)
    {
        var current = new FlowExtractor<IObjectSignature>(reader, (IObjectSignature)_es).Action(taken, out var found);
        var printed = ModuleFlow.Print(current);
        var currentText = found.Count == 0 && printed.Unprintable.Count == 0 && ModuleFlow.Check(current, printed) == null ? printed.Text : null;
        return new("FLOW_ACTION_NAME_TAKEN", "a text without @key creates an action, but " + where + " " + reader.KindOf(taken) + " " + reader.NameOf(taken)
            + " (@" + taken.ObjectKey + "): to change that action, edit its text (header with @key, lines with their ids)", taken.ObjectKey!.ToString(),
            currentText != null ? "edit the text below (its textSha " + ModuleFlow.TextSha(currentText) + " is the basedOn) and send it, or give the new action another name"
                : "give the new action another name; that action is not a fixed point of its text (change it with the logic op replace)", currentText);
    }

    // The module's own action of that name (server, service or client, any case), if any.
    private IObjectSignature? ModuleAction(string name, string kind)
    {
        if (name.Length == 0) return null;
        return new Anvil.Core.Preflight.ModelBaseFacts(this, _espace).ActionElement(name, kind);
    }

    /// <summary>The names a new client action may not take (ScopeNames): the creation battery's patches take theirs from it.</summary>
    internal HashSet<string> ActionScopeNames() => ScopeNames();

    // The names a new client action may not take: every action of the module and of its references (of any kind: a screen's
    // and a block's included), screen, block and flow, any case.
    private HashSet<string> ScopeNames()
    {
        var reader = new KernelModelReader();
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var element in reader.Walk((IObjectSignature)_es)) {
            if (element.WasDeleted) continue;
            var kind = reader.KindOf(element);
            if (kind.EndsWith("Action", StringComparison.Ordinal) || kind.EndsWith("Screen", StringComparison.Ordinal) || kind.EndsWith("Block", StringComparison.Ordinal)
                || kind.EndsWith("Flow", StringComparison.Ordinal) || Implements(element, "IActionSignature"))
                if (reader.NameOf(element) is { Length: > 0 } name) names.Add(name);
        }
        return names;
    }

    /// <summary>What the model says that a logic text does not (FlowDiff's IFlowTypes), seen from the action the text edits:
    /// the type of a variable or input of its screen or block (then a module variable), the sources of an aggregate of that
    /// screen or block, and the attributes of an entity or structure of the module or its references in their order.</summary>
    private sealed class ModelFlowTypes(ModelSession session, IObjectSignature? action, IObjectSignature? under = null) : IFlowTypes
    {
        private readonly KernelModelReader reader = new();
        private Dictionary<string, List<IObjectSignature>>? byName;

        // The screen or block of the action (of a new one: the owner it is born under), then the module.
        private IEnumerable<IObjectSignature> Owners()
        {
            for (var at = action?.Parent as IObjectSignature ?? under; at != null; at = at.Parent as IObjectSignature)
                if (!ReferenceEquals(at, session._es)) yield return at;
        }

        private List<IObjectSignature> Named(string name)
        {
            if (byName == null) {
                byName = new(StringComparer.OrdinalIgnoreCase);
                foreach (var element in reader.Walk((IObjectSignature)session._es)) {
                    var display = reader.NameOf(element);
                    if (display.Length == 0 || element.WasDeleted) continue;
                    (byName.TryGetValue(display, out var list) ? list : byName[display] = []).Add(element);
                }
            }
            return byName.GetValueOrDefault(name) ?? [];
        }

        public string? TypeOf(string name)
        {
            foreach (var owner in Owners())
                foreach (var child in reader.ChildrenOf(owner))
                    if (reader.KindOf(child) is "LocalVariable" or "InputParameter" && string.Equals(reader.NameOf(child), name, StringComparison.OrdinalIgnoreCase))
                        return Type(child);
            var module = Named(name).Where(e => DdlRules.VariableKinds.Contains(reader.KindOf(e))).ToList();
            return module.Count == 1 ? Type(module[0]) : null;
            static string? Type(IObjectSignature variable) => ModelHost.Prop(variable, "DataType") is { } type ? UiCatalog.TypeName(type) : null;
        }

        public IReadOnlyList<(string Alias, string Record)>? SourcesOf(string aggregate)
        {
            foreach (var owner in Owners())
                foreach (var child in reader.ChildrenOf(owner))
                    if (reader.KindOf(child).Contains("Aggregate", StringComparison.Ordinal) && string.Equals(reader.NameOf(child), aggregate, StringComparison.OrdinalIgnoreCase))
                        return reader.Walk(child).Skip(1).Where(s => reader.KindOf(s) == "AliasedSource")
                            .Select(s => (reader.NameOf(s), ModelHost.Prop(s, "Source") is { } source ? TypeResolver.Name(source) ?? reader.NameOf(s) : reader.NameOf(s))).ToList();
            return null;
        }

        public IReadOnlyList<string>? AttributesOf(string record)
        {
            var records = Named(record).Where(e => reader.KindOf(e) is var kind && (kind.EndsWith("Entity", StringComparison.Ordinal) || kind.EndsWith("Structure", StringComparison.Ordinal))).ToList();
            if (records.Count != 1) return null;
            return reader.ChildrenOf(records[0]).Where(c => reader.KindOf(c).EndsWith("Attribute", StringComparison.Ordinal)).Select(c => reader.NameOf(c)).ToList();
        }

        public string? AttributeTypeOf(string record, string attribute)
        {
            var records = Named(record).Where(e => reader.KindOf(e) is var kind && (kind.EndsWith("Entity", StringComparison.Ordinal) || kind.EndsWith("Structure", StringComparison.Ordinal))).ToList();
            if (records.Count != 1) return null;
            var found = reader.ChildrenOf(records[0]).Where(c => reader.KindOf(c).EndsWith("Attribute", StringComparison.Ordinal) && string.Equals(reader.NameOf(c), attribute, StringComparison.OrdinalIgnoreCase)).ToList();
            return found.Count == 1 && ModelHost.Prop(found[0], "DataType") is { } type ? UiCatalog.TypeName(type) : null;
        }

        // The mandatory attributes of the one entity or structure of that name (an entity's identifier always: the Verify requires
        // it in a mapping on both lanes, whatever its own flag): the identifier holds NullIdentifier() in a local nothing assigned;
        // another mandatory attribute holds what its default says, which is not certain here.
        public IReadOnlyList<(string Attribute, string? Value)>? MandatoryOf(string record)
        {
            var records = Named(record).Where(e => reader.KindOf(e) is var kind && (kind.EndsWith("Entity", StringComparison.Ordinal) || kind.EndsWith("Structure", StringComparison.Ordinal))).ToList();
            if (records.Count != 1) return null;
            var identifier = ModelHost.Prop(records[0], "IdentifierAttribute");
            return reader.ChildrenOf(records[0]).Where(c => reader.KindOf(c).EndsWith("Attribute", StringComparison.Ordinal) && (ReferenceEquals(c, identifier) || ModelHost.Prop(c, "IsMandatory") is true))
                .Select(c => (reader.NameOf(c), ReferenceEquals(c, identifier) ? "NullIdentifier()" : (string?)null)).ToList();
        }

        // The type of an input of the action a call names, through the session's own resolution of the callee (the closest action
        // of that name for that kind of call).
        public string? InputTypeOf(string callee, string? callKind, string parameter)
        {
            IObjectSignature called;
            try { called = session.Callee(callee, action, callKind); } catch (Exception error) when (error is KernelRefusalException or KeyNotFoundException or InvalidOperationException) { return null; }
            var input = reader.ChildrenOf(called).FirstOrDefault(c => reader.KindOf(c).EndsWith("InputParameter", StringComparison.Ordinal) && string.Equals(reader.NameOf(c), parameter, StringComparison.OrdinalIgnoreCase));
            return input != null && ModelHost.Prop(input, "DataType") is { } type ? UiCatalog.TypeName(type) : null;
        }

        // The identifier attribute of the one entity of that name.
        public string? IdentifierOf(string record)
        {
            var records = Named(record).Where(e => reader.KindOf(e).EndsWith("Entity", StringComparison.Ordinal)).ToList();
            if (records.Count != 1 || ModelHost.Prop(records[0], "IdentifierAttribute") is not IObjectSignature identifier) return null;
            return reader.NameOf(identifier) is { Length: > 0 } name ? name : null;
        }
    }

    // The order the texts are written in: a new action another text of the op names is created before it (an action a node
    // calls, the handler an event of a data action goes to, the data action a refresh fetches, the event a trigger raises; a
    // text that fills the shell of an html document of the job is one that names, never one that is named); the order of the
    // texts otherwise (and inside a cycle).
    private static List<int> CreationOrder(List<FlowPlan> plans)
    {
        var order = new List<int>();
        var state = new int[plans.Count];   // 0 not seen, 1 in progress, 2 done
        void Visit(int i)
        {
            if (state[i] != 0) return;
            state[i] = 1;
            var named = plans[i].Edited?.Items.SelectMany(Named).Where(n => n.Length > 0).ToHashSet(StringComparer.OrdinalIgnoreCase) ?? [];
            for (var j = 0; j < plans.Count; j++)
                if (j != i && plans[j].Baseline == null && plans[j].Edited is { Name.Length: > 0 } callee && named.Contains(callee.Name)) Visit(j);
            state[i] = 2;
            order.Add(i);
        }
        for (var i = 0; i < plans.Count; i++) Visit(i);
        return order;

        static IEnumerable<string> Named(FlowItem item) => item.Role switch {
            "node" when item.Kind == "Execute" => [item.Prop("Action") ?? ""],
            "node" when item.Kind == "RefreshDataNode" => [item.Prop("DataSource") ?? ""],
            "node" when item.Kind == "TriggerNode" => [item.Prop("Event") ?? ""],
            "event" => [item.Prop("Destination") ?? ""],
            _ => [] };
    }


    /// <summary>
    /// Applies one edited action text inside the current command and answers what it did, with the action's text as it now
    /// reads (and its textSha, the basedOn of a next edit). Throws a coded refusal with every problem, or FLOW_NOT_EXACT when
    /// the action does not read back as the text.
    /// </summary>
    public JsonObject ApplyFlowText(string text, string? basedOn = null, string pointer = "/flow")
    {
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var ms = new JsonObject();
        void Phase(string name) { ms[name] = Math.Round(clock.Elapsed.TotalMilliseconds, 1); clock.Restart(); }
        var prefix = FlowDiff.AliasPrefix + ++_flowTexts + ".";
        var plan = PlanFlowText(text, basedOn, prefix);
        if (plan.Problems.Count > 0) throw Refusal([.. plan.Problems.Select(p => (pointer, p))]);
        var reader = new KernelModelReader();
        var (action, baseline, read, diff) = (plan.Action, plan.Baseline, plan.Read, plan.Diff!);
        Phase("read");
        var was = _verbatim;
        _verbatim = true;
        var applied = new Dictionary<string, int>(StringComparer.Ordinal);
        // The elements of the action by key, so a reference to one of them never walks the module (Resolve's miss does).
        _flowObjects = action == null ? new(StringComparer.Ordinal) : reader.Walk(action).Where(o => o.ObjectKey != null).ToDictionary(o => o.ObjectKey!.ToString()!, StringComparer.Ordinal);
        _flowObjectsOf = action;
        string actionKey;
        Dictionary<string, string> keyOf;
        var defaults = new JsonArray();
        var platform = new List<JsonObject>();
        var mappingRefused = new List<JsonObject>();
        var settled = 0;
        var template = 0;
        FlowItem after;
        string? difference;
        try {
        try {
            var ops = diff.Ops;
            for (var i = 0; i < ops.Count; i++) {
                // A run of argument writes of one call goes in the order of the call's parameters.
                if (ops[i]["_argOf"]?.ToString() is { } call) {
                    var end = i;
                    while (end + 1 < ops.Count && ops[end + 1]["_argOf"]?.ToString() == call) end++;
                    if (end > i) {
                        var order = ParameterOrder(call);
                        // A record literal goes after the others: a generic parameter (ListAppend's Element) takes its record
                        // type from another argument (List), which must be written first.
                        var run = ops.GetRange(i, end - i + 1).OrderBy(o => o["value"]?.ToString()?.TrimStart().StartsWith('{') == true ? 1 : 0).ThenBy(o => {
                            var name = o["target"]!.ToString()[(o["target"]!.ToString().LastIndexOf("/arg:", StringComparison.Ordinal) + 5)..];
                            var at = order.IndexOf(name);
                            return at < 0 ? int.MaxValue : at;
                        }).ToList();
                        ops = [.. ops.Take(i), .. run, .. ops.Skip(end + 1)];
                    }
                }
                JsonObject? ready;
                // A name the text writes that resolves to nothing (or to several) is refused at its text (the pointer).
                try { ready = Materialize(ops[i], action); }
                catch (KernelRefusalException error) when (error.Code is "FLOW_NAME_UNKNOWN" or "FLOW_NAME_AMBIGUOUS" or "FLOW_AGGREGATE_MASTER_SOURCE") { throw AtText(error, pointer); }
                if (ready == null) continue;
                try { ApplyOne(ready); }
                catch (Exception error) when (LiteralRetry(ready, error)) { ApplyOne(ready); }
                catch (Exception error) when (Errors.FindCoded(error) is KernelRefusalException { Code: "FLOW_NOT_EXACT" } coded) { throw AtText(coded, pointer); }
                applied[ready["op"]!.ToString()] = applied.GetValueOrDefault(ready["op"]!.ToString()) + 1;
                // A new action is the text whole: the nodes and parameters the Studio puts in a new action (the template
                // comment of a service action, the Out1 of a data action) go before the text's are written.
                if (baseline == null && ready["as"]?.ToString() == prefix + "action" && Resolve(prefix + "action") is IObjectSignature fresh) {
                    // The new action owns the ops that follow (the kind of flow decides the calls).
                    action = fresh;
                    var born = fresh.Children.OfType<IObjectSignature>().Where(c => c is IFlowNode
                        || Implements(c, "IInputParameter") || Implements(c, "IOutputParameter") || Implements(c, "ILocalVariable")).ToList();
                    foreach (var element in born) {
                        ApplyOne(new JsonObject { ["op"] = "delete", ["target"] = "@" + element.ObjectKey, ["force"] = true });
                        template++;
                    }
                }
            }
        } finally { _verbatim = was; }
        action ??= (IObjectSignature)Resolve(prefix + "action");
        FlushPendingMappings(pointer, diff.Expected, new ModelFlowTypes(this, action));
        Phase("ops");
        actionKey = action.ObjectKey!.ToString()!;
        // The keys the creates gave, by alias.
        keyOf = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (alias, value) in _handles)
            if (alias.StartsWith(prefix, StringComparison.Ordinal) && value is IObjectSignature { ObjectKey: not null } created) keyOf[alias] = created.ObjectKey.ToString()!;
        var expected = diff.Expected.Clone();
        Rekey(expected, keyOf);
        // Read it again: it must be the text. A value the platform changed on the way is written again (settle).
        var types = new ModelFlowTypes(this, action);
        for (var round = 0; ; round++) {
            after = new FlowExtractor<IObjectSignature>(reader, (IObjectSignature)_es).Action(action, out _);
            AcceptDefaults(expected, after, keyOf.Values.ToHashSet(StringComparer.Ordinal), defaults);
            DefaultCalls(expected, after);
            MappingOrder(expected, after);
            PlatformMappings(expected, after, pointer, platform, mappingRefused, types);
            difference = Difference(expected.Canon(), after.Canon());
            if (difference == null || round == 2) break;
            var fixes = Settle(expected, after);
            if (fixes.Count == 0) break;
            _verbatim = true;
            try { foreach (var fix in fixes) { if (Materialize(fix, action) is { } ready) { ApplyOne(ready); settled++; } } }
            finally { _verbatim = was; }
        }
        } finally {
            // The references pinned for this text go: a later op resolves them again (an element may be gone).
            foreach (var pinned in _flowPins) _handles.Remove(pinned);
            _flowPins.Clear(); _flowObjects = null; _flowObjectsOf = null;
            _pendingMappings.Clear();
            _mappingRewrites.Clear();
        }
        Phase("verify");
        // The mappings the platform writes in its own form are listed with what the text said (the text of a next edit is the
        // action as it reads now, in the answer).
        if (difference == null && mappingRefused.Count == 0 && platform.Count > 0) Normalized(platform);
        // A mapping the platform keeps in a form that says something else is refused with its reason (never taken silently),
        // together with whatever else does not read back.
        if (mappingRefused.Count > 0 || difference != null) {
            var problems = new JsonArray(mappingRefused.Select(p => (JsonNode)p).ToArray());
            if (difference != null)
                problems.Add(JobPreflight.PublicProblem(JobPreflight.Problem(null, pointer, "FLOW_NOT_EXACT", "error",
                    "after the ops the action reads differently from the text (" + difference + ")",
                    "nothing was kept; report it with the text (the engine could not write this construction exactly)")));
            throw mappingRefused.Count > 0
                ? new KernelRefusalException("FLOW_MAPPING_TYPES", "logic: the action " + after.Name + ": " + mappingRefused.Count + " mapping(s) the platform keeps in a form that says something else: "
                    + string.Join(" | ", mappingRefused.Select(p => p["message"]?.ToString())) + (difference != null ? "; and it does not read back as the text: " + difference : ""), problems)
                : new KernelRefusalException("FLOW_NOT_EXACT", "logic: the action " + after.Name + " does not read back as the text: " + difference, problems);
        }
        var now = ModuleFlow.Print(after);
        // The text the action reads as now is the read of a next edit (its textSha, the basedOn): kept, so that edit is merged
        // if the action changes again before it arrives.
        KeepFlowReading(after, now);
        var idOf = now.Keys.ToDictionary(p => p.Value, p => p.Key, StringComparer.Ordinal);
        string Id(string key) => idOf.GetValueOrDefault(key, key);
        // A shell of an html document of this job is filled once: a later text of the same name is a name taken.
        if (plan.Shell) _flowShells.Remove(actionKey);
        // Every id of the text with the model key of its element, for the check of a patch (JobRunner's patch round).
        if (_applyOps != null)
            FlowTextsWritten.Add(new(_applyIndex, pointer, text, actionKey, diff.Mapped.ToDictionary(p => p.Key, p => keyOf.GetValueOrDefault(p.Value, p.Value), StringComparer.Ordinal)));
        // The sorts written as the Studio writes them (FlowDiff.Sorts.cs): listed in the receipt, never silent.
        var inJob = _applyOps != null && OpsPointer != null ? $"{OpsPointer}/{_applyIndex}/data" : "";
        foreach (var (id, from, to, why) in diff.SortNormalizations) {
            Report("expressionRewrites", inJob + pointer + "/@" + id + "/SORT", from, to);
            Note(AggregateSortRule.NormalizedCode, $"{after.Name} @{id}: SORT {from} is written {(to == "(removed)" ? "nowhere (removed)" : "SORT " + to)}, as the Studio writes a sort: {why}");
        }
        foreach (var (id, from, to, why) in diff.JoinNormalizations) {
            Report("expressionRewrites", inJob + pointer + "/@" + id + "/JOIN", from, to);
            Note(AggregateSortRule.JoinNormalizedCode, $"{after.Name} @{id}: JOIN {from} is written JOIN {to}, as the Studio writes a join: {why}");
        }
        return new JsonObject {
            ["action"] = after.Name, ["owner"] = after.Owner.Length > 0 ? after.Owner : null, ["key"] = actionKey, ["kind"] = after.Kind, ["new"] = baseline == null || plan.Shell,
            ["filledShell"] = plan.Shell ? true : null,
            ["ops"] = new JsonObject(applied.OrderBy(p => p.Key, StringComparer.Ordinal).Select(p => KeyValuePair.Create(p.Key, (JsonNode?)p.Value))),
            ["created"] = new JsonObject(diff.Created.Where(c => keyOf.ContainsKey(c.Value)).Select(c => KeyValuePair.Create(c.Key, (JsonNode?)("@" + Id(keyOf[c.Value]))))),
            // The model key of each element the text created, by the id the text gave it (FlowBattery reads it back with them).
            ["keys"] = new JsonObject(diff.Created.Where(c => keyOf.ContainsKey(c.Value)).Select(c => KeyValuePair.Create(c.Key, (JsonNode?)keyOf[c.Value]))),
            ["recreated"] = diff.Recreated.Count == 0 ? null : new JsonArray(diff.Recreated.Select(r => (JsonNode)new JsonObject { ["id"] = r.Id, ["now"] = keyOf.TryGetValue(r.Alias, out var k) ? "@" + Id(k) : null }).ToArray()),
            ["deleted"] = diff.Deleted.Count == 0 ? null : new JsonArray(diff.Deleted.Select(k => (JsonNode)("@" + (read?.Keys.FirstOrDefault(p => p.Value == k).Key ?? k))).ToArray()),
            ["renamed"] = diff.Renamed.Count == 0 ? null : new JsonArray(diff.Renamed.Select(r => (JsonNode)new JsonObject { ["from"] = r.From, ["to"] = r.To }).ToArray()),
            ["nodeNames"] = diff.NodeNames.Count == 0 ? null : new JsonArray(diff.NodeNames.Select(n => (JsonNode)new JsonObject { ["id"] = n.Id, ["asked"] = n.Asked, ["given"] = n.Given }).ToArray()),
            ["sorts"] = diff.SortNormalizations.Count == 0 ? null : new JsonArray(diff.SortNormalizations.Select(n => (JsonNode)new JsonObject { ["id"] = n.Id, ["from"] = n.From, ["to"] = n.To, ["why"] = n.Why }).ToArray()),
            ["joins"] = diff.JoinNormalizations.Count == 0 ? null : new JsonArray(diff.JoinNormalizations.Select(n => (JsonNode)new JsonObject { ["id"] = n.Id, ["from"] = n.From, ["to"] = n.To, ["why"] = n.Why }).ToArray()),
            ["defaults"] = defaults.Count == 0 ? null : defaults, ["settled"] = settled > 0 ? settled : null, ["templateNodesRemoved"] = template > 0 ? template : null,
            ["merged"] = plan.Merged?.DeepClone(),
            ["textSha"] = ModuleFlow.TextSha(now.Text), ["text"] = now.Text, ["ms"] = ms };
    }

    // One refusal with every problem of every text (each with the pointer of its text).
    // ODC: a record literal written into a generic argument (ListAppend's Element) can fail once inside the platform, which
    // retypes the literal while it fills its fields ("Cannot create an object under a deleted parent"). The same value
    // written again goes through; the read back still decides whether the action is the text.
    private static bool LiteralRetry(JsonObject op, Exception error) =>
        op["op"]?.ToString() == "set" && op["prop"]?.ToString() == "Value" && op["target"]?.ToString()?.Contains("/arg:", StringComparison.Ordinal) == true
        && op["value"]?.ToString()?.TrimStart().StartsWith('{') == true
        && error.GetBaseException() is InvalidOperationException { Message: var message } && message.Contains("deleted parent", StringComparison.Ordinal);

    // The same refusal with the pointer of its text on every problem that has none.
    private static KernelRefusalException AtText(KernelRefusalException error, string pointer)
    {
        var problems = error.Problems?.DeepClone().AsArray() ?? new JsonArray(JobPreflight.PublicProblem(JobPreflight.Problem(null, pointer, error.Code, "error", error.Message, null)));
        foreach (var problem in problems.OfType<JsonObject>()) if (problem["pointer"] is null) problem["pointer"] = pointer;
        return new KernelRefusalException(error.Code, error.Message, problems);
    }

    // patch: the op's patch (paths relative to op.data, FlowTextForm.Patch), on every problem whose fix it writes.
    private static KernelRefusalException Refusal(IReadOnlyList<(string Pointer, FlowProblem Problem)> problems, JsonArray? patch = null) =>
        new(problems[0].Problem.Code, "logic: the text of the action is refused: " + string.Join(" | ", problems.Select(p => p.Problem.Code + ": " + p.Problem.Message)),
            new JsonArray(problems.Select(entry => (JsonNode)JobPreflight.PublicProblem(FlowTextForm.Problem(entry.Problem, entry.Pointer, patch))).ToArray()));

    // ---- materialize: the marks of FlowDiff become plain verbs --------------------------------------------------------

    // The parameter names of a call node's arguments, in the order the action it calls declares its inputs (the order a generic
    // parameter needs: ListAppend's Element after List); else in the model's order of its Arguments list (which ODC does not
    // keep in the order of the parameters).
    private List<string> ParameterOrder(string call)
    {
        object node;
        var probe = new JsonObject { ["target"] = call };
        Pin(probe, "target");
        try { node = Resolve(probe["target"]!.ToString()); } catch (Exception) { return []; }
        if (ModelHost.Prop(node, "Action") is IObjectSignature callee) {
            var reader = new KernelModelReader();
            var declared = reader.ChildrenOf(callee).Where(c => reader.KindOf(c).Contains("InputParameter", StringComparison.Ordinal)).Select(reader.NameOf).Where(n => n.Length > 0).ToList();
            if (declared.Count > 0) return declared;
        }
        var arguments = ModelHost.Prop(node, "Arguments") as System.Collections.IEnumerable;
        return arguments?.Cast<object>().Select(ArgumentName).OfType<string>().ToList() ?? [];
    }

    private Dictionary<string, IObjectSignature>? _flowObjects;
    private IObjectSignature? _flowObjectsOf;
    private readonly List<string> _flowPins = [];

    // "@key" or "@key/arg:Name" of an element of the action, resolved from the action's own elements (walked again once
    // when a key is new) and pinned as a handle of that exact reference for the ops of this text.
    private void Pin(JsonObject op, string field)
    {
        if (op[field] is not JsonValue v || !v.TryGetValue<string>(out var reference) || !reference.StartsWith('@') || _handles.ContainsKey(reference)) return;
        var at = reference.IndexOf("/arg:", StringComparison.Ordinal);
        var key = at > 0 ? reference[1..at] : reference[1..];
        if (_flowObjects == null) return;
        if (!_flowObjects.TryGetValue(key, out var element) && _flowObjectsOf != null) {
            foreach (var o in new KernelModelReader().Walk(_flowObjectsOf)) if (o.ObjectKey != null) _flowObjects[o.ObjectKey.ToString()!] = o;
            _flowObjects.TryGetValue(key, out element);
        }
        if (element == null || element.WasDeleted) return;
        object pinned = element;
        if (at > 0) {
            try { pinned = ResolveChild(element, reference[(at + 1)..]); } catch (KeyNotFoundException) { return; }
        }
        _handles[reference] = pinned;
        _flowPins.Add(reference);
    }

    private JsonObject? Materialize(JsonObject op, IObjectSignature? action)
    {
        var ready = op.DeepClone().AsObject();
        if (ready["_event"]?.ToString() is { } eventName) {
            if (action == null || ModelHost.Prop(action, eventName) is not IObjectSignature { ObjectKey: not null } handler)
                throw new KernelRefusalException("FLOW_NAME_UNKNOWN", $"logic: the action has no lifecycle event {eventName}");
            var target = ready["target"]!.ToString();
            ready["target"] = "@" + handler.ObjectKey + (target.Contains("/arg:", StringComparison.Ordinal) ? target[target.IndexOf("/arg:", StringComparison.Ordinal)..] : "");
        }
        foreach (var field in new[] { "target", "from", "to", "parent" }) Pin(ready, field);
        if (ready["_optional"] is not null) {
            try { Resolve(ready["target"]!.ToString()); } catch (Exception) { return null; }
        }
        if (ready["_execute"]?.ToString() is { } calleeText) {
            var owner = action ?? Resolve(ready["parent"]!.ToString()) as IObjectSignature;
            var call = ready["_call"]?.ToString();
            var callee = Callee(calleeText, owner, call, out var shared);
            // The kind of node: what the text says (Call=); for a name two actions share, the kind its flow picks (the read
            // writes Call= only for the other kind); else the kind of the action it calls.
            var clientNode = call != null ? call == "Client"
                : shared && owner != null ? ClientFlow(owner)
                : Implements(callee, "IClientAction") || Implements(callee, "IClientActionSignature") || Implements(callee, LogicOrder.MobileScreenAction);
            ready["type"] = clientNode ? "IExecuteClientActionNode" : "IExecuteServerActionNode";
        }
        if (ready["_ref"]?.ToString() is { } refProperty) {
            if (refProperty.StartsWith("args.", StringComparison.Ordinal)) {
                var arg = refProperty[5..];
                var text = ready["args"]![arg]!.ToString();
                var element = Display(text, ready["type"]?.ToString() == "ISQLOutput" ? "EntityOrStructure" : "Source", null, action);
                ready["args"]![arg] = "@" + element.ObjectKey;
            } else {
                var target = Resolve(ready["target"]!.ToString());
                var text = ready["value"]!.ToString();
                if (refProperty == "Action") ready["value"] = "@" + Callee(text, action, ready["_call"]?.ToString()).ObjectKey;
                else if (refProperty != "DataType") ready["value"] = "@" + Display(text, refProperty, target, action).ObjectKey;
            }
        }
        if (ready["_source"]?.ToString() is { } aggregateRef) {
            var aggregate = (IObjectSignature)Resolve(aggregateRef);
            var name = ready["value"]!.ToString();
            var reader = new KernelModelReader();
            var source = reader.Walk(aggregate).Skip(1).Where(s => reader.KindOf(s) is "AliasedSource" or "AddSourceOperation" && reader.NameOf(s) == name).ToList();
            var aliased = source.Where(s => reader.KindOf(s) == "AliasedSource").ToList();
            var chosen = (aliased.Count > 0 ? aliased : source);
            if (chosen.Count != 1) throw new KernelRefusalException("FLOW_NAME_UNKNOWN", $"logic: the aggregate has {chosen.Count} sources named {name}");
            // ODC exposes the join tree's master as a read-only reference. The text prints it, so a text that declares
            // the same reference is an assertion, not a request to change the tree. A different reference is refused.
            if (ready["prop"]?.ToString() == "MasterSource" && FindProperty(aggregate, "MasterSource") is { CanWrite: false } masterProperty) {
                var actual = masterProperty.GetValue(aggregate);
                bool SameSource(object? left, object? right) => left != null && right != null && (ReferenceEquals(left, right)
                    || left is IObjectSignature a && right is IObjectSignature b && a.ObjectKey == b.ObjectKey);
                if (SameSource(actual, chosen[0]) || SameSource(actual, ModelHost.Prop(chosen[0], "SourceOperation"))) return null;
                throw new KernelRefusalException("FLOW_AGGREGATE_MASTER_SOURCE", "logic: MasterSource is derived from the aggregate's join tree and does not match " + name
                    + "; keep the master source of the read or change the sources and joins that determine it");
            }
            ready["value"] = "@" + chosen[0].ObjectKey;
        }
        if (ready["_attach"]?.ToString() is { } attach) {
            var comment = (IObjectSignature)Resolve(ready["from"]!.ToString());
            foreach (var connector in comment.Children.OfType<IObjectSignature>().Where(c => Implements(c, "ICommentConnector")).ToList())
                ApplyOne(new JsonObject { ["op"] = "delete", ["target"] = "@" + connector.ObjectKey, ["force"] = true });
            if (attach == "detach") return null;
        }
        foreach (var mark in ready.Select(p => p.Key).Where(k => k.StartsWith('_')).ToList()) ready.Remove(mark);
        return ready;
    }

    // ---- references: the names the reader writes, resolved back -------------------------------------------------------

    // A client flow: a client action or a screen action of a reactive or mobile screen (FlowExtractor's clientFlow).
    private bool ClientFlow(IObjectSignature action) => Implements(action, "IClientAction") || Implements(action, LogicOrder.MobileScreenAction);

    private IObjectSignature Callee(string text, IObjectSignature? action, string? call = null) => Callee(text, action, call, out _);

    // call: Client or Server when the text says which kind of call it is (Call=, a name two actions share), else null: the
    // kind the flow picks. shared: more than one action has the name.
    private IObjectSignature Callee(string text, IObjectSignature? action, string? call, out bool shared, bool again = false)
    {
        var reader = new KernelModelReader();
        if (_flowCallees == null) {
            _flowCallees = new(StringComparer.Ordinal);
            var extractor = new FlowExtractor<IObjectSignature>(reader, (IObjectSignature)_es);
            foreach (var element in reader.Walk((IObjectSignature)_es))
                if (Implements(element, "IActionSignature") || reader.KindOf(element).EndsWith("Action", StringComparison.Ordinal))
                    (_flowCallees.TryGetValue(extractor.Callee(element), out var list) ? list : _flowCallees[extractor.Callee(element)] = []).Add(element);
        }
        var found = _flowCallees.GetValueOrDefault(text)?.Where(e => !e.WasDeleted).ToList() ?? [];
        // An action created after the names were gathered (an earlier text or op of the job): gathered again once.
        if (found.Count == 0 && !again) { _flowCallees = null; _flowCalls = null; return Callee(text, action, call, out shared, true); }
        shared = found.Count > 1;
        if (found.Count == 0)
            throw new KernelRefusalException("FLOW_NAME_UNKNOWN", $"logic: no action is named {text} in this module or its references",
                new JsonArray(JobPreflight.PublicProblem(JobPreflight.Problem(null, null, "FLOW_NAME_UNKNOWN", "error", $"no action {text}",
                    "name an action of the module, or of a producer it references (Producer.Action, (System).Action)"))));
        bool IsClient(IObjectSignature e) => Implements(e, "IClientAction") || Implements(e, "IClientActionSignature") || Implements(e, LogicOrder.MobileScreenAction);
        var flowClient = action != null && ClientFlow(action);
        // The kind of call: the text's (Call=), else the flow's: a client flow calls the client action of a name both kinds
        // have (A27), a server flow the server one.
        var nodeClient = call != null ? call == "Client" : found.Count > 1 && action != null ? flowClient : (bool?)null;
        if (found.Count > 1 && nodeClient is { } node) {
            // The actions of that kind, else the ones the module's calls of that kind name (a role's client and server
            // checks are both action signatures).
            var kind = found.Where(e => IsClient(e) == node).ToList();
            if (kind.Count > 0 && kind.Count < found.Count) found = kind;
            else if (found.Where(e => CallsOf(e, node) > 0).ToList() is { Count: > 0 } used) found = used;
        }
        if (found.Count > 1) found = Closest(found, action);
        if (found.Count > 1) {
            // Still several: the one the module's calls of that kind name most.
            var used = found.Select(e => (Element: e, Calls: CallsOf(e, nodeClient ?? flowClient))).ToList();
            var most = used.Max(u => u.Calls);
            if (most > 0 && used.Count(u => u.Calls == most) == 1) found = [used.Single(u => u.Calls == most).Element];
        }
        if (found.Count != 1)
            throw new KernelRefusalException("FLOW_NAME_AMBIGUOUS", $"logic: {found.Count} actions are named {text}: " + string.Join(", ", found.Take(4).Select(e => reader.KindOf(e) + " @" + e.ObjectKey)),
                new JsonArray(JobPreflight.PublicProblem(JobPreflight.Problem(null, null, "FLOW_NAME_AMBIGUOUS", "error", $"{found.Count} actions are named {text}",
                    "write the kind of call on the node's @{...} line: Call=Client or Call=Server"))));
        return found[0];
    }

    private Dictionary<(IObjectSignature, bool), int>? _flowCalls;

    // How many client (or server) execute nodes of the module call this action.
    private int CallsOf(IObjectSignature callee, bool client)
    {
        if (_flowCalls == null) {
            _flowCalls = new();
            var reader = new KernelModelReader();
            foreach (var node in reader.Walk((IObjectSignature)_es)) {
                var kind = reader.KindOf(node);
                if (FlowRules.NodeKind(kind) != "Execute" || ModelHost.Prop(node, "Action") is not IObjectSignature target) continue;
                var clientNode = kind.Contains("Client", StringComparison.Ordinal);
                _flowCalls[(target, clientNode)] = _flowCalls.GetValueOrDefault((target, clientNode)) + 1;
            }
        }
        return _flowCalls.GetValueOrDefault((callee, client));
    }

    // The element a reference property names by the reader's display name (Name, or Label without one), of a type the
    // property takes; the closest to the action when several do.
    private IObjectSignature Display(string text, string property, object? target, IObjectSignature? action, bool again = false)
    {
        var reader = new KernelModelReader();
        if (_flowDisplay == null) {
            _flowDisplay = new(StringComparer.Ordinal);
            foreach (var element in reader.Walk((IObjectSignature)_es)) {
                var name = reader.DisplayOf(element);
                if (name.Length == 0) name = reader.KindOf(element);
                (_flowDisplay.TryGetValue(name, out var list) ? list : _flowDisplay[name] = []).Add(element);
            }
        }
        var type = target == null ? null : FindProperty(target, property)?.PropertyType;
        bool Fits(IObjectSignature e) => type != null ? type.IsInstanceOfType(e)
            : property == "EntityOrStructure" ? Implements(e, "IEntitySignature") || Implements(e, "IStructureSignature") || Implements(e, "IRecordSignature") || Implements(e, "IServerEntity") || Implements(e, "IStructure")
            : Implements(e, "IEntitySignature") || Implements(e, "IServerEntity") || Implements(e, "IStaticEntity") || Implements(e, "IClientEntity");
        var found = (_flowDisplay.GetValueOrDefault(text) ?? []).Where(e => !e.WasDeleted && Fits(e)).ToList();
        // A parameter or variable of the same name as a source, screen or exception is never what a reference names.
        if (found.Count > 1 && found.Where(e => !(Implements(e, "IInputParameter") || Implements(e, "IOutputParameter") || Implements(e, "ILocalVariable"))).ToList() is { Count: > 0 } named)
            found = named;
        // Nor a node of a flow (a navigate is named after its destination: RedirectToURL, Login), what lies inside one, or
        // the operation tree of an aggregate (a source named after its entity): a reference names a screen, an action, an
        // entity, an exception, a data source.
        if (found.Count > 0 && found.Where(e => !Inner(e)).ToList() is { Count: > 0 } outer && outer.Count < found.Count) found = outer;
        // A navigation goes to a screen or an external site: an action of the same name (a screen action Login beside the
        // screen Login, the System action Login) is not its destination while one of those is there.
        if (property == "Destination" && found.Count > 1 && found.Where(e => !reader.KindOf(e).EndsWith("Action", StringComparison.Ordinal) && !reader.KindOf(e).EndsWith("ActionSignature", StringComparison.Ordinal)).ToList() is { Count: > 0 } places
            && places.Count < found.Count) found = places;
        if (found.Count > 1) found = Closest(found, action);
        if (found.Count == 1) return found[0];
        // An element created after the names were gathered (an earlier op of the job): gathered again once.
        if (found.Count == 0 && !again) { _flowDisplay = null; return Display(text, property, target, action, true); }
        throw new KernelRefusalException(found.Count == 0 ? "FLOW_NAME_UNKNOWN" : "FLOW_NAME_AMBIGUOUS",
            $"logic: {property} {text}: " + (found.Count == 0 ? "no element of this module or its references has that name for that property"
                : found.Count + " elements have it: " + string.Join(", ", found.Take(4).Select(e => reader.KindOf(e) + " @" + e.ObjectKey + (e.Parent is IObjectSignature holder ? " (in " + reader.KindOf(holder) + " " + reader.DisplayOf(holder) + ")" : "")))),
            new JsonArray(JobPreflight.PublicProblem(JobPreflight.Problem(null, null, found.Count == 0 ? "FLOW_NAME_UNKNOWN" : "FLOW_NAME_AMBIGUOUS", "error",
                $"{property} = {text}", found.Count == 0 ? "write the name the element has in the module (ssam_map)" : "the name is shared; the action cannot say which one"))));
    }

    private static readonly HashSet<string> AggregateParts = new(StringComparer.Ordinal) {
        "AliasedSource", "AddSourceOperation", "CombineSourcesOperation", "GroupByOperation", "Join", "Filter", "Sort", "GroupByAttribute", "AggregateAttribute", "CalculatedAttribute" };

    // A node of a flow (a child whose kind ends in Node of an action of any kind: an OnException action, a preparation), an element
    // below one, a part of an aggregate's operation tree, or a widget. A screen or an external site is a node of a UI flow,
    // not this.
    private static bool Inner(IObjectSignature element)
    {
        var reader = new KernelModelReader();
        if (AggregateParts.Contains(reader.KindOf(element)) || Implements(element, "IWidget")) return true;
        for (var at = element; at.Parent is IObjectSignature parent; at = parent)
            if ((reader.KindOf(parent).EndsWith("Action", StringComparison.Ordinal) || reader.KindOf(parent) == "Preparation") && reader.KindOf(at).EndsWith("Node", StringComparison.Ordinal)) return true;
        return false;
    }

    // Among elements of the same name, the ones whose nearest common owner with the action is deepest (same screen, then
    // same flow, then the module).
    private static List<IObjectSignature> Closest(List<IObjectSignature> found, IObjectSignature? action)
    {
        if (action == null) return found;
        var chain = new List<object>();
        for (object? at = action; at != null; at = (at as IObjectSignature)?.Parent) chain.Add(at);
        int Depth(IObjectSignature element)
        {
            for (object? at = element; at != null; at = (at as IObjectSignature)?.Parent) {
                var index = chain.FindIndex(c => ReferenceEquals(c, at));
                if (index >= 0) return chain.Count - index;
            }
            return 0;
        }
        var best = found.Max(Depth);
        return found.Where(e => Depth(e) == best).ToList();
    }

    // ---- read back ----------------------------------------------------------------------------------------------------

    private static void Rekey(FlowItem item, IReadOnlyDictionary<string, string> keyOf)
    {
        if (keyOf.TryGetValue(item.Key, out var key)) item.Key = key;
        foreach (var edge in item.Edges.Keys.ToList()) if (keyOf.TryGetValue(item.Edges[edge], out var target)) item.Edges[edge] = target;
        foreach (var child in item.Items) Rekey(child, keyOf);
    }

    // A new element keeps what the Studio gave it and the text left out (a name, a label, a default): added to the
    // expected model and reported. Nothing of an element the text kept is accepted this way.
    private static void AcceptDefaults(FlowItem expected, FlowItem after, HashSet<string> created, JsonArray defaults)
    {
        void Accept(FlowItem want, FlowItem got, string where)
        {
            if (want.Name.Length == 0 && got.Name.Length > 0 && want.Role is "node" or "action") { want.Name = got.Name; defaults.Add(where + " Name=" + got.Name); }
            foreach (var (name, value) in got.Props)
                if (!want.Props.ContainsKey(name)) { want.Props[name] = value; defaults.Add(where + " " + name + "=" + value.Text); }
        }
        if (created.Contains(after.Key)) Accept(expected, after, "action");
        var byKey = after.Items.Where(i => FlowItem.Keyed(i.Role)).ToDictionary(i => i.Key, StringComparer.Ordinal);
        foreach (var item in expected.Items.Where(i => FlowItem.Keyed(i.Role) && created.Contains(i.Key))) {
            if (!byKey.TryGetValue(item.Key, out var got)) continue;
            Accept(item, got, item.Role + " " + (item.Name.Length > 0 ? item.Name : item.Kind));
            foreach (var parameter in item.Items.Where(p => FlowItem.Keyed(p.Role) && created.Contains(p.Key)))
                if (got.Items.FirstOrDefault(p => p.Key == parameter.Key) is { } gotParameter) Accept(parameter, gotParameter, "parameter " + parameter.Name);
        }
    }

    // A new call whose text says the kind of call its flow picks by default (Call=Client in a client flow): the read leaves
    // it out, and the node is the kind the text asked for.
    private static void DefaultCalls(FlowItem expected, FlowItem after)
    {
        var byKey = after.Items.Where(i => i.Role == "node").ToDictionary(i => i.Key, StringComparer.Ordinal);
        foreach (var node in expected.Items.Where(i => i.Role == "node" && i.Kind == "Execute"))
            if (node.Prop(FlowRules.CallProperty) is { } call && byKey.TryGetValue(node.Key, out var got) && got.Prop(FlowRules.CallProperty) == null && got.CallKind == call)
                node.Props.Remove(FlowRules.CallProperty);
    }

    // A mapping the text writes in another order of fields (or another case of a field name) than the platform keeps it (O11:
    // the order of the target's attributes) says the same: the expected value takes the order the action reads with. Only a
    // value whose source and every field and value are the same is taken (FlowMapping.SameMapping).
    private static void MappingOrder(FlowItem expected, FlowItem after)
    {
        var byKey = after.Items.Where(i => i.Role == "node").ToDictionary(i => i.Key, StringComparer.Ordinal);
        foreach (var node in expected.Items.Where(i => i.Role == "node" && !i.Opaque)) {
            if (!byKey.TryGetValue(node.Key, out var got)) continue;
            foreach (var role in new[] { "assignment", "argument" }) {
                // Assignments pair by position (their order means something), arguments by the parameter they bind.
                var want = node.Items.Where(p => p.Role == role).ToList();
                var have = got.Items.Where(p => p.Role == role).ToList();
                for (var i = 0; i < want.Count; i++) {
                    var theirs = role == "argument" ? have.FirstOrDefault(p => p.Name == want[i].Name) : i < have.Count ? have[i] : null;
                    if (theirs == null || want[i].Prop("Value") is not { } wanted || theirs.Prop("Value") is not { } read || wanted == read) continue;
                    if (wanted.Contains(" mapTo {", StringComparison.Ordinal) && FlowMapping.SameMapping(wanted, read)) want[i].Props["Value"] = new('e', read);
                }
            }
        }
    }

    // A value the platform keeps in its own form, which says what the text said (VisitaCerta 2026-10-12), is taken as it reads
    // and listed (notes); one that says something else is refused with its reason (refused, FLOW_MAPPING_TYPES), never taken:
    //  - FLOW_MAPPING_PLATFORM (both lanes): a mapping that copies every attribute of the target (its type read from the model)
    //    from the namesakes of one record of the item, which the platform keeps as the plain value (a row of that one record)
    //    or as `Value: Record` (O11: the writer wrote it so, IRecordMappings.Equivalent; ODC: the expression reads so);
    //  - FLOW_MAPPING_STUDIO: a plain value whose conversion the platform fills by itself (a row of several entities assigned
    //    to a list of one of them reads `Rows mapTo { Value: Entity }`), only when that mapping takes the record whole or fills
    //    every attribute of the target: a mapping that leaves an attribute empty is refused with the attributes it leaves;
    //  - a mapping the platform drops (the action reads the plain value) that is not the same is refused with the reason.
    // Paired as MappingOrder pairs: assignments by position, arguments by parameter.
    private void PlatformMappings(FlowItem expected, FlowItem after, string pointer, List<JsonObject> notes, List<JsonObject> refused, IFlowTypes types)
    {
        var byKey = after.Items.Where(i => i.Role == "node").ToDictionary(i => i.Key, StringComparer.Ordinal);
        foreach (var node in expected.Items.Where(i => i.Role == "node" && !i.Opaque)) {
            if (!byKey.TryGetValue(node.Key, out var got)) continue;
            foreach (var role in new[] { "assignment", "argument" }) {
                var want = node.Items.Where(p => p.Role == role).ToList();
                var have = got.Items.Where(p => p.Role == role).ToList();
                for (var i = 0; i < want.Count; i++) {
                    var theirs = role == "argument" ? have.FirstOrDefault(p => p.Name == want[i].Name) : i < have.Count ? have[i] : null;
                    if (theirs == null || want[i].Prop("Value") is not { } wanted || theirs.Prop("Value") is not { } read || wanted == read) continue;
                    var variable = role == "assignment" ? want[i].Prop("Variable") : null;
                    var where = (node.Name.Length > 0 ? node.Name + ": " : "") + (variable != null ? variable + " = " : role == "argument" ? want[i].Name + "=" : "");
                    // The type the value goes to: the assignment's variable, or the parameter the argument binds.
                    var target = role == "assignment" ? DeclaredType(expected, variable, types) : ArgumentType(expected, node, got.Key, want[i].Name, types);
                    string? rule = null, message = null;
                    var mapping = wanted.Contains(" mapTo {", StringComparison.Ordinal) ? FlowMapping.Split(wanted) : null;
                    if ((_mappingRewrites.TryGetValue(wanted, out var written) && written == read)
                        || mapping is { } given && SameAsPlatform(expected, given, read, target, types)) {
                        rule = "FLOW_MAPPING_PLATFORM";
                        message = read.Contains(" mapTo {", StringComparison.Ordinal)
                            ? "the mapping copies every attribute of the target from one record of each item: the platform maps that record whole (" + read + ")"
                            : "the mapping copies every attribute of the target from the item's only record: the platform converts it by itself, with no mapping (" + read + ")";
                    } else if (mapping == null && !wanted.Contains(" mapTo {", StringComparison.Ordinal) && FlowMapping.Split(read) is { } studio && studio.Source == wanted) {
                        var attributes = target != null ? types.AttributesOf(ElementOf(target)) : null;
                        // The attributes of the target the platform's mapping does not fill: empty in every item.
                        var empty = attributes?.Where(a => !studio.Fields.Any(f => string.Equals(f.Field, a, StringComparison.OrdinalIgnoreCase))).ToList();
                        // `Value: R` takes the record R whole only where the target has no attribute named Value and R is a record
                        // of the item (an alias of its row, or an attribute of a record type of its structure): else it is the
                        // attribute Value, and the other attributes stay empty (re-check of 2026-10-12, probes N1, N1b, N1c).
                        var whole = studio.Fields is [("Value", var record)] && attributes != null
                            && !attributes.Contains("Value", StringComparer.OrdinalIgnoreCase) && RecordOfItem(expected, studio.Source, record, types);
                        if (empty is { Count: 0 } || whole) {
                            rule = "FLOW_MAPPING_STUDIO";
                            message = "the value converts to the target's type with the mapping the platform fills by itself: the action reads " + read;
                        } else {
                            var unknown = empty == null || empty.Count == attributes!.Count && studio.Fields is [("Value", _)];
                            var filled = string.Join(", ", studio.Fields.Select(f => f.Field + ": " + f.Value).Concat((unknown ? Enumerable.Empty<string>() : empty!).Select(a => a + ": <value>")));
                            refused.Add(JobPreflight.PublicProblem(JobPreflight.Problem(null, pointer, "FLOW_MAPPING_TYPES", "error",
                                where + wanted + ": the value converts to the target's type with the mapping the platform fills by itself, " + read
                                    + (!unknown ? ", which leaves " + string.Join(", ", empty!) + " empty in every item"
                                        : empty == null ? ", and the engine cannot tell which attributes of the target it leaves empty"
                                        : ", and the engine cannot tell that " + studio.Fields[0].Value + " is a record of each item (the record whole)"),
                                !unknown ? "write the mapping whole, each attribute of the target with its value: " + studio.Source + " mapTo { " + filled + " }"
                                    : "write the mapping whole (" + studio.Source + " mapTo { <each attribute of the target>: <value> })")));
                        }
                    } else if (mapping is { } told && FlowMapping.Split(read) is { } fuller && fuller.Source == told.Source && fuller.Fields.Count > told.Fields.Count
                        && told.Fields.All(f => fuller.Fields.Any(g => string.Equals(g.Field, f.Field, StringComparison.OrdinalIgnoreCase) && g.Value == f.Value))) {
                        // The platform fills the attributes the mapping leaves out by itself (ODC: from their namesakes of the item):
                        // the action reads more than the text said (re-check of 2026-10-12, probe N7b).
                        var added = fuller.Fields.Where(g => !told.Fields.Any(f => string.Equals(f.Field, g.Field, StringComparison.OrdinalIgnoreCase))).ToList();
                        var whole = string.Join(", ", fuller.Fields.Select(g => g.Field + ": " + (added.Contains(g) ? "<value>" : g.Value)));
                        refused.Add(JobPreflight.PublicProblem(JobPreflight.Problem(null, pointer, "FLOW_MAPPING_TYPES", "error",
                            where + wanted + ": the mapping leaves " + string.Join(", ", added.Select(g => g.Field)) + " of the target out, and the platform fills "
                                + (added.Count == 1 ? "it" : "them") + " by itself (" + string.Join(", ", added.Select(g => g.Field + ": " + g.Value)) + "): the action would read " + read,
                            "map every attribute of the target with the value you mean: " + fuller.Source + " mapTo { " + whole + " } (the platform's own: "
                                + string.Join(", ", added.Select(g => g.Field + ": " + g.Value)) + ")")));
                    } else if (mapping is { } dropped && read == dropped.Source) {
                        refused.Add(JobPreflight.PublicProblem(JobPreflight.Problem(null, pointer, "FLOW_MAPPING_TYPES", "error",
                            where + wanted + ": the platform keeps no such mapping (the action reads " + read + "), and "
                                + (target != null && types.AttributesOf(ElementOf(target)) != null
                                    ? "it is not the conversion the platform makes by itself: it names no record of the item whole, nor every attribute of the target (" + ElementOf(target) + ") from the item's one record"
                                    : "the engine cannot tell the target's type to say it is the conversion the platform makes by itself"),
                            "map each attribute of the target from the record you mean (Field: Record.Field for every attribute), or write " + dropped.Source + " without mapTo when the platform's own conversion is meant")));
                    } else continue;
                    want[i].Props["Value"] = new('e', read);
                    if (rule != null) notes.Add(Preflight.JobNormalizer.Entry(rule, pointer, wanted, read, (node.Name.Length > 0 ? node.Name + ": " : "") + message));
                }
            }
        }
    }

    // The declared type of the target of an assignment written as a name: a parameter or local of the action, else what the
    // model says (a variable of its screen or block, a module variable); null when the text cannot tell.
    private static string? DeclaredType(FlowItem action, string? variable, IFlowTypes types)
    {
        if (variable == null || !FlowSyntax.IsIdentifier(variable)) return null;
        var declared = action.Items.FirstOrDefault(i => i.Role is "in" or "out" or "local" && string.Equals(i.Name, variable, StringComparison.OrdinalIgnoreCase));
        return declared != null ? declared.Prop("DataType") : types.TypeOf(variable);
    }

    private static string ElementOf(string type) => type.EndsWith(" List", StringComparison.Ordinal) ? type[..^5] : type;

    // The type an argument takes: of a List action (ListAppend, ListAppendAll, ListInsert) its List argument's (the generic
    // parameter takes it), else the type of the called action's parameter in the model; null when neither says.
    private string? ArgumentType(FlowItem action, FlowItem node, string nodeKey, string name, IFlowTypes types)
    {
        var callee = node.Prop("Action") ?? "";
        var simple = callee[(callee.LastIndexOf('.') + 1)..];
        if (simple is "ListAppend" or "ListAppendAll" or "ListInsert")
            return name is "Element" or "SourceList" && node.Items.FirstOrDefault(p => p.Role == "argument" && p.Name == "List")?.Prop("Value") is { } list
                ? DeclaredType(action, list, types) : null;
        try {
            if (Resolve("@" + nodeKey) is { } model && ModelHost.Prop(model, "Arguments") is System.Collections.IEnumerable arguments)
                foreach (var argument in arguments.Cast<object>())
                    if (string.Equals(ArgumentName(argument), name, StringComparison.OrdinalIgnoreCase) && ModelHost.Prop(argument, "Parameter") is { } parameter
                        && ModelHost.Prop(parameter, "DataType") is { } type)
                        return UiCatalog.TypeName(type);
        } catch (Exception) { /* the model does not say: the type stays unknown */ }
        return null;
    }

    // The records of the item a mapping's source holds, by alias with the entity each reads: the sources of an aggregate of
    // the action (Agg.List, Agg.List.Current), or of its screen or block; null when the text cannot tell.
    private static IReadOnlyList<(string Alias, string Record)>? ItemRecords(FlowItem action, string source, IFlowTypes types)
    {
        var name = source.Trim();
        if (name.EndsWith(".Current", StringComparison.OrdinalIgnoreCase)) name = name[..^8];
        if (!name.EndsWith(".List", StringComparison.OrdinalIgnoreCase)) return null;
        name = name[..^5];
        if (!FlowSyntax.IsIdentifier(name)) return null;
        if (action.Items.FirstOrDefault(i => i.Role == "node" && i.Kind == "AggregateNode" && string.Equals(i.Name, name, StringComparison.OrdinalIgnoreCase)) is { } aggregate)
            return aggregate.Items.Where(p => p.Role == "source").Select(p => (p.Name, p.Prop("Source") ?? p.Name)).ToList();
        return types.SourcesOf(name);
    }

    // Whether name is a record of each item of the source: an alias of the row of an aggregate (ItemRecords), or an attribute
    // of a record type (an entity or structure of the module) of the source's element (a list or record of a structure).
    internal static bool RecordOfItem(FlowItem action, string source, string name, IFlowTypes types)
    {
        if (!FlowSyntax.IsIdentifier(name)) return false;
        if (ItemRecords(action, source, types) is { } records) return records.Any(r => string.Equals(r.Alias, name, StringComparison.OrdinalIgnoreCase));
        var bare = source.Trim();
        if (bare.EndsWith(".Current", StringComparison.OrdinalIgnoreCase)) bare = bare[..^8];
        return DeclaredType(action, bare, types) is { } type && types.AttributeTypeOf(ElementOf(type).Trim(), name) is { } member
            && types.AttributesOf(ElementOf(member).Trim()) != null && !member.EndsWith(" List", StringComparison.Ordinal);
    }

    /// <summary>The record a mapping copies whole: every attribute of the target once, each from its namesake (any case) of
    /// the same record R written as a name (`Field: R.Field`); R, or null.</summary>
    internal static string? WholeRecord(IReadOnlyList<(string Field, string Value)> fields, IReadOnlyList<string> attributes)
    {
        if (fields.Count == 0 || fields.Count != attributes.Count) return null;
        string? record = null;
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (field, value) in fields) {
            var dot = value.LastIndexOf('.');
            if (dot <= 0 || !FlowSyntax.IsIdentifier(value[..dot]) || !string.Equals(value[(dot + 1)..], field, StringComparison.OrdinalIgnoreCase)
                || !attributes.Contains(field, StringComparer.OrdinalIgnoreCase) || !seen.Add(field)) return null;
            if (record == null) record = value[..dot];
            else if (!string.Equals(record, value[..dot], StringComparison.OrdinalIgnoreCase)) return null;
        }
        return record;
    }

    // A mapping that copies every attribute of the target from the item's only record, of the target's type: the plain source
    // says the same (FlushPendingMappings, where the platform has no conversion for the value).
    private static bool PlainRecord(FlowItem action, string? variable, string source, IReadOnlyList<(string Field, string Value)> fields, IFlowTypes types) =>
        DeclaredType(action, variable, types) is { } type && types.AttributesOf(ElementOf(type)) is { } attributes && WholeRecord(fields, attributes) is { } record
        && ItemRecords(action, source, types) is [var only] && string.Equals(only.Alias, record, StringComparison.OrdinalIgnoreCase)
        && string.Equals(only.Record, ElementOf(type), StringComparison.OrdinalIgnoreCase);

    // Lane-independent (the model's types, never the lane's mapping API): the mapping the text wrote copies every attribute of
    // the target from one record R of the item, and the platform reads it as `Source mapTo { Value: R }` (the record whole) or
    // as the plain source when the item is a row of that one record, of the target's type.
    private static bool SameAsPlatform(FlowItem action, (string Source, List<(string Field, string Value)> Fields) mapping, string read, string? type, IFlowTypes types)
    {
        if (type == null || types.AttributesOf(ElementOf(type)) is not { } attributes
            || WholeRecord(mapping.Fields, attributes) is not { } record) return false;
        if (FlowMapping.Split(read) is { } form)
            return form.Source == mapping.Source && form.Fields.Count == 1 && form.Fields[0].Field == "Value" && string.Equals(form.Fields[0].Value, record, StringComparison.OrdinalIgnoreCase);
        return read == mapping.Source && ItemRecords(action, mapping.Source, types) is [var only]
            && string.Equals(only.Alias, record, StringComparison.OrdinalIgnoreCase) && string.Equals(only.Record, ElementOf(type), StringComparison.OrdinalIgnoreCase);
    }

    // The values (properties and arguments) of kept and new elements that read differently from the text: written again.
    private List<JsonObject> Settle(FlowItem expected, FlowItem after)
    {
        var fixes = new List<JsonObject>();
        var byKey = after.Items.Where(i => FlowItem.Keyed(i.Role)).ToDictionary(i => i.Key, StringComparer.Ordinal);
        void Values(FlowItem want, FlowItem got, string target)
        {
            if (want.Role == "node" && want.Name != got.Name && want.Name.Length > 0)
                fixes.Add(new JsonObject { ["op"] = "set", ["target"] = target, ["prop"] = "Name", ["value"] = want.Name });
            foreach (var (name, value) in want.Props)
                if (!got.Props.TryGetValue(name, out var has) || has.Text != value.Text) {
                    if (value.Type == 'r' || name == "MasterSource") continue;
                    fixes.Add(new JsonObject { ["op"] = "set", ["target"] = target, ["prop"] = name,
                        ["value"] = value.Type == 'v' && value.Text is "True" or "False" ? JsonValue.Create(value.Text == "True") : JsonValue.Create(value.Text) });
                }
            var args = want.Items.Where(i => i.Role == "argument").ToDictionary(i => i.Name, i => i.Prop("Value") ?? "", StringComparer.Ordinal);
            var gotArgs = got.Items.Where(i => i.Role == "argument").ToDictionary(i => i.Name, i => i.Prop("Value") ?? "", StringComparer.Ordinal);
            foreach (var name in args.Keys.Union(gotArgs.Keys))
                if (args.GetValueOrDefault(name, "") != gotArgs.GetValueOrDefault(name, ""))
                    fixes.Add(new JsonObject { ["op"] = "set", ["target"] = target + "/arg:" + name, ["prop"] = "Value", ["value"] = args.GetValueOrDefault(name, "") });
        }
        Values(expected, after, "@" + after.Key);
        foreach (var item in expected.Items.Where(i => FlowItem.Keyed(i.Role) && !i.Opaque))
            if (byKey.TryGetValue(item.Key, out var got)) {
                Values(item, got, "@" + item.Key);
                foreach (var parameter in item.Items.Where(p => FlowItem.Keyed(p.Role)))
                    if (got.Items.FirstOrDefault(p => p.Key == parameter.Key) is { } gotParameter) Values(parameter, gotParameter, "@" + parameter.Key);
            }
        return fixes;
    }

    private static string? Difference(string expected, string actual)
    {
        if (expected == actual) return null;
        var a = expected.Split('\n'); var b = actual.Split('\n');
        for (var i = 0; i < Math.Max(a.Length, b.Length); i++) {
            var x = i < a.Length ? a[i].Trim() : "(end)"; var y = i < b.Length ? b[i].Trim() : "(end)";
            if (x == y) continue;
            // The passage around the first column where they differ (a long line would hide it).
            var at = 0;
            while (at < x.Length && at < y.Length && x[at] == y[at]) at++;
            return "expected " + Around(x, at) + " | read " + Around(y, at);
        }
        return "(same lines)";
        static string Around(string text, int at)
        {
            if (text.Length <= 240) return text;
            var start = Math.Max(0, Math.Min(at - 100, text.Length - 240));
            return (start > 0 ? "…" : "") + text.Substring(start, Math.Min(240, text.Length - start)) + (start + 240 < text.Length ? "…" : "");
        }
    }

}

/// <summary>The data of the logic op's text form, read without the model: JobPreflight reads it where no Studio is bound
/// (a reference to ModelSession would load the Model API assemblies with the method that names it).</summary>
internal static class FlowTextForm
{
    /// <summary>The declaration's header independently of its body: a malformed later line does not hide its name.</summary>
    internal static FlowItem? Header(string text)
    {
        var line = Lf(text).Split('\n').FirstOrDefault(l => l.Length > 0 && !string.IsNullOrWhiteSpace(l) && !l.StartsWith("///", StringComparison.Ordinal));
        if (line == null) return null;
        try { return ModuleFlow.Read(line + "\n  end\n"); }
        catch (FormatException) { return null; }
    }
    /// <summary>The texts of data.flow with their basedOn and pointer.</summary>
    // Windows line endings are the same text (FlowParser reads them the same way), and the action read back is compared
    // with this text: one form for both.
    private static string Lf(string text) => text.Replace("\r\n", "\n");

    internal static List<(string Text, string? BasedOn, string Pointer)> Texts(JsonObject data)
    {
        var list = new List<(string, string?, string)>();
        var shared = data["basedOn"] is JsonValue b && b.TryGetValue<string>(out var all) ? all : null;
        switch (data["flow"]) {
            case JsonValue single when single.TryGetValue<string>(out var text): list.Add((Lf(text), shared, "/flow")); break;
            case JsonArray items:
                // A list of one text takes the shared data.basedOn (dropping it would read the text's ids against the action now).
                var one = items.Count == 1 ? shared : null;
                for (var i = 0; i < items.Count; i++) {
                    if (items[i] is JsonValue v && v.TryGetValue<string>(out var t)) list.Add((Lf(t), one, $"/flow/{i}"));
                    else if (items[i] is JsonObject o && o["text"] is JsonValue tv && tv.TryGetValue<string>(out var ot))
                        list.Add((Lf(ot), o["basedOn"] is JsonValue bv && bv.TryGetValue<string>(out var based) ? based : one, $"/flow/{i}"));
                    else throw new KernelRefusalException("FLOW_SYNTAX", $"logic: data.flow[{i}] is a text or {{\"text\", \"basedOn\"}}");
                }
                if (shared != null && items.Count > 1) throw new KernelRefusalException("FLOW_SYNTAX", "logic: data.basedOn names one text; with several, each item is {\"text\", \"basedOn\"}");
                break;
            default: throw new KernelRefusalException("FLOW_SYNTAX", "logic: data.flow is the text of an action (ssam-flow/1) or a list of them");
        }
        return list;
    }

    /// <summary>The names of the actions the texts write (their headers), any case; a text that does not parse names none.</summary>
    internal static HashSet<string> ActionNames(IEnumerable<(string Text, string? BasedOn, string Pointer)> texts)
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (text, _, _) in texts) {
            try { if (ModuleFlow.Read(text).Name is { Length: > 0 } name) names.Add(name); }
            catch (FormatException) { }
        }
        return names;
    }

    /// <summary>
    /// The patch of a logic op in the text form (paths relative to op.data): each text with the certain fixes of its problems
    /// (corrected, by the index of Texts; null keeps the text) and the new action texts the fixes need after them. It writes the
    /// whole data.flow (or the whole data, when data.basedOn must go on an item: a single text or a list of one that becomes a
    /// list of several, or a basedOn that moves), so the same patch on every problem it fixes, applied once or twice, writes the
    /// same job. rebased: the basedOn a corrected text goes with when it is not its own (a merged text is written on the action
    /// now: its corrections carry the textSha of now, and the text is not merged again).
    /// </summary>
    internal static JsonArray Patch(JsonObject data, IReadOnlyList<(string Text, string? BasedOn, string Pointer)> texts, IReadOnlyList<string?> corrected, IReadOnlyList<string> added,
        IReadOnlyList<string?>? rebased = null)
    {
        bool Changed(int i) => corrected.Count > i && corrected[i] != null;
        string At(int i) => Changed(i) ? corrected[i]! : texts[i].Text;
        string? BasedOn(int i) => Changed(i) && rebased != null && rebased.Count > i && rebased[i] != null ? rebased[i] : texts[i].BasedOn;
        var moved = Enumerable.Range(0, texts.Count).Any(i => BasedOn(i) != texts[i].BasedOn);
        if (data["flow"] is JsonValue) {
            if (added.Count == 0 && !moved) return new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = "/flow", ["value"] = At(0) });
            var single = data.DeepClone().AsObject();
            if (added.Count == 0) {
                single["flow"] = At(0);
                if (BasedOn(0) is { } own) single["basedOn"] = own; else single.Remove("basedOn");
                return new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = "", ["value"] = single });
            }
            var items = new JsonArray(BasedOn(0) is { } based ? new JsonObject { ["text"] = At(0), ["basedOn"] = based } : JsonValue.Create(At(0)));
            foreach (var text in added) items.Add(text);
            single.Remove("basedOn");
            single["flow"] = items;
            return new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = "", ["value"] = single });
        }
        var list = data["flow"]!.DeepClone().AsArray();
        // A list of one text that takes data.basedOn: once the list grows or the basedOn moves, it goes on the item.
        var whole = data["basedOn"] is JsonValue && (added.Count > 0 || moved);
        for (var i = 0; i < list.Count && i < texts.Count; i++) {
            var basedOn = BasedOn(i);
            var itemBase = list[i] is JsonObject o && o["basedOn"] is JsonValue;
            var carry = basedOn != null && (basedOn != texts[i].BasedOn || whole && !itemBase);
            if (!Changed(i) && !carry) continue;
            if (list[i] is JsonObject item) { item["text"] = At(i); if (carry) item["basedOn"] = basedOn; }
            else list[i] = carry ? new JsonObject { ["text"] = At(i), ["basedOn"] = basedOn } : JsonValue.Create(At(i));
        }
        foreach (var text in added) list.Add(text);
        if (!whole) return new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = "/flow", ["value"] = list });
        var rest = data.DeepClone().AsObject();
        rest.Remove("basedOn");
        rest["flow"] = list;
        return new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = "", ["value"] = rest });
    }

    /// <summary>One problem of a text as a problem of the job (pointer relative to op.data, as the text's): its id, the line or block
    /// of its fix (text), the op's patch when this problem has a certain fix, its own fields, and the data of the refusal (a ready
    /// edit, the merged text, the conflicts of a merge) as it is.</summary>
    internal static JsonObject Problem(FlowProblem p, string? pointer, JsonArray? patch)
    {
        var problem = JobPreflight.Problem(null, pointer, p.Code, "error", p.Message, p.Fix, p.Corrected != null && patch != null ? patch.DeepClone().AsArray() : null);
        if (p.Id != null) problem["id"] = p.Id;
        if (p.Patch != null) problem["text"] = p.Patch;
        if (p.Fields != null) foreach (var (key, value) in p.Fields) problem[key] ??= value?.DeepClone();
        if (p.Data != null) foreach (var (name, value) in p.Data) problem[name] = value?.DeepClone();
        return problem;
    }
}
