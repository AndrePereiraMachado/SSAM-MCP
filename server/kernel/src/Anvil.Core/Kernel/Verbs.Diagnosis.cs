using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using OutSystems.Model;
using ServiceStudio.Model;

namespace Anvil.Core;

/// <summary>
/// primeira-certa A2 (decision of the owner, 2026-10-10): a job with problems is refused ONCE, with every problem of every
/// phase. This file is the session's part: the apply that keeps its failures instead of throwing them (so the Verify of
/// what did apply still runs; the candidate is never saved), the op that wrote each element (anchors, recorded as the verbs
/// create, register and touch objects) and the Verify errors mapped back to the op and the JSON pointer of the job, each
/// with a fix. The kernel never corrects the job: the fix and the patch are for the author.
/// </summary>
public sealed partial class ModelSession
{
    /// <summary>The apply failures kept by <see cref="KeepFailures"/>: their problems (phase "apply"), the APPLY_SKIPPED
    /// warnings, the text of each failure, and the refusal the plain apply would have thrown (null when nothing failed and
    /// only ops the preflight refused were left out).</summary>
    public sealed record KeptApply(List<JsonObject> Problems, List<JsonObject> Warnings, List<string> Lines, Exception? Refusal);

    /// <summary>When true, Apply records its failures in <see cref="Kept"/> and returns, the successful ops applied, instead
    /// of throwing; the caller runs the Verify and refuses with every phase (JobRunner.ApplyResolved).</summary>
    public bool KeepFailures { get; set; }

    /// <summary>Ops the preflight refused whole (a JSON shape it could not read): never run; the ops that use what they
    /// would have created are skipped, as after an apply failure.</summary>
    public IReadOnlySet<int>? SkipOps { get; set; }

    public KeptApply? Kept { get; private set; }

    /// <summary>Set when the Studio's own check at the end of the apply command failed after failures were kept (an element
    /// a failed op left half-built): the Verify cannot run on that model; the kept failures stay the refusal.</summary>
    public string? EndOfApplyFailure { get; private set; }

    // The op that last created, registered or touched each object (K7 by object, not by sweep): the origin of a Verify message
    // is the nearest anchored ancestor of its owner. What an op that failed created stays in the model half-built (the apply
    // keeps going); it is anchored to that op in _failedAnchors, and its Verify messages are that failure again, not news.
    private int? _anchorOp;
    private readonly Dictionary<object, int> _anchors = new(ReferenceEqualityComparer.Instance);
    private readonly Dictionary<object, int> _failedAnchors = new(ReferenceEqualityComparer.Instance);
    // The op that created each object (a later set of one property moves its anchor, never its creator).
    private readonly Dictionary<object, int> _creators = new(ReferenceEqualityComparer.Instance);
    private readonly List<(object Target, int? Previous, bool Created)> _anchorJournal = [];

    private void Anchor(object? o, bool created = false)
    {
        if (_anchorOp is not { } op || o is not IObjectSignature) return;
        _anchorJournal.Add((o, _anchors.TryGetValue(o, out var previous) ? previous : null, created));
        _anchors[o] = op;
        if (created) _creators[o] = op;
    }

    // The op whose set last wrote each property of an object (UI-Mockup, FarmaVirtual call 99): the anchor of the object is
    // the last op that touched it, so the Verify of its Values pointed at the set of its Labels, or nowhere at all.
    private readonly Dictionary<(object Target, string Prop), int> _propertyAnchors = new(new TargetProperty());

    /// <summary>A set wrote <paramref name="op"/>.prop of <paramref name="target"/> (Set, after the write succeeded).</summary>
    private void AnchorProperty(object target, JsonObject op)
    {
        if (_anchorOp is { } index && op["prop"]?.ToString() is { Length: > 0 } prop) _propertyAnchors[(target, prop)] = index;
    }

    private sealed class TargetProperty : IEqualityComparer<(object Target, string Prop)>
    {
        public bool Equals((object Target, string Prop) a, (object Target, string Prop) b)
            => ReferenceEquals(a.Target, b.Target) && string.Equals(a.Prop, b.Prop, StringComparison.OrdinalIgnoreCase);
        public int GetHashCode((object Target, string Prop) x)
            => HashCode.Combine(System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(x.Target), StringComparer.OrdinalIgnoreCase.GetHashCode(x.Prop));
    }

    /// <summary>Starts the anchors of one op (Apply, per top-level op).</summary>
    private void BeginAnchors(int op) { _anchorOp = op; _anchorJournal.Clear(); }

    /// <summary>Ends the anchors of one op: a failed op gives back what it touched to the op before, and what it created
    /// becomes a failed anchor.</summary>
    private void EndAnchors(bool failed)
    {
        if (failed && _anchorOp is { } op)
            for (var k = _anchorJournal.Count - 1; k >= 0; k--)
            {
                var (target, previous, created) = _anchorJournal[k];
                if (created) { _anchors.Remove(target); _creators.Remove(target); _failedAnchors[target] = op; }
                else if (previous is { } before) _anchors[target] = before;
                else _anchors.Remove(target);
            }
        _anchorJournal.Clear();
        _anchorOp = null;
    }

    private static KeptApply KeptFailures(List<ApplyFailure> failures, List<(int Op, int Because, string Uses)> skipped, string? opsPointer)
    {
        var warnings = skipped.Select(s => JobPreflight.PublicProblem(JobPreflight.Problem(s.Op, opsPointer == null ? null : $"{opsPointer}/{s.Op}",
            "APPLY_SKIPPED", "warning", $"skipped: it uses {s.Uses}, which failed op #{s.Because} would have created", $"fix op #{s.Because}; this op runs with it"))).ToList();
        var lines = failures.Select(f => f.Error.Message).Concat(skipped.Select(s => $"op #{s.Op} skipped: it uses {s.Uses} of failed op #{s.Because}")).ToList();
        if (failures.Count == 0) return new([], warnings, lines, null);
        var refusal = ApplyRefusal(failures, skipped, opsPointer);
        var problems = new List<JsonObject>();
        foreach (var p in (Errors.FindCoded(refusal)?.Problems ?? new JsonArray()).OfType<JsonObject>())
        {
            var copy = p.DeepClone().AsObject();
            copy["phase"] ??= "apply";
            if (copy["op"] == null && failures.Count == 1) copy["op"] = failures[0].Op;
            problems.Add(copy);
        }
        return new(problems, warnings, lines, refusal);
    }

    // ---- primeira-certa A6: the actions of a logic op, isolated ------------------------------------------------------------

    /// <summary>The declared action (its index in the op's data.actions) a generated op of LogicCore belongs to.</summary>
    internal const string LogicActionKey = "anvil.logic.action";

    /// <summary>A logic op that applied without its failed actions: the failures (one per failed round, each problem with the
    /// pointer of its action in the op as written), the APPLY_SKIPPED warnings of the actions that use a failed one, the
    /// failed actions as an op (what later ops must not use), the result of the op without them (null when none was left)
    /// and the indices of the actions kept.</summary>
    private sealed record Isolation(List<ApplyFailure> Failures, List<JsonObject> Warnings, JsonObject Broken, JsonNode? Result, JsonArray Kept);

    private static readonly Regex ActionPointer = new(@"^/actions/(\d+)(?=/|$)", RegexOptions.Compiled);
    private static readonly Regex QuotedName = new(@"'([^']+)'", RegexOptions.Compiled);

    /// <summary>The index in <paramref name="data"/>.actions of the declared action whose alias the generated op
    /// <paramref name="generated"/> names (its own create, or a parent, target or link under it).</summary>
    private static int? ActionOfGenerated(JsonObject generated, List<JsonObject> expanded, JsonObject data)
    {
        if (data["actions"] is not JsonArray declared) return null;
        var aliases = new List<(string Alias, int Index)>();
        for (var j = 0; j < declared.Count; j++)
        {
            if (declared[j] is not JsonObject action || action["name"]?.ToString() is not { Length: > 0 } name) continue;
            var owner = Preflight.JobFacts.Owner(action);
            var create = expanded.FirstOrDefault(x => x["op"]?.ToString() == "create" && string.Equals(x["name"]?.ToString(), name, StringComparison.Ordinal)
                && x["as"]?.ToString() is { } alias && alias.StartsWith("$" + name, StringComparison.Ordinal)
                && string.Equals(x["parent"]?.ToString(), owner, StringComparison.OrdinalIgnoreCase));
            if (create?["as"]?.ToString() is { } found) aliases.Add((found, j));
        }
        var texts = generated.Where(p => p.Key is not ("name" or "value" or "description")).Select(p => p.Value).OfType<JsonValue>()
            .Select(v => v.TryGetValue<string>(out var s) ? s : null).OfType<string>().ToList();
        return aliases.Where(a => texts.Any(t => t == a.Alias || t.StartsWith(a.Alias + "/", StringComparison.Ordinal) || t.StartsWith(a.Alias + ".", StringComparison.Ordinal)))
            .OrderByDescending(a => a.Alias.Length).Select(a => (int?)a.Index).FirstOrDefault();
    }

    /// <summary>The actions of <paramref name="attempt"/> a failure names: the action of the generated op (LogicCore), the
    /// /actions/&lt;j&gt; of a coded expansion problem, or the one declared action the message quotes by name.</summary>
    private static SortedSet<int> Culprits(Exception error, JsonObject attempt)
    {
        var found = new SortedSet<int>();
        var actions = attempt["data"]!["actions"]!.AsArray();
        for (var e = error; e != null; e = e.InnerException)
            if (e.Data.Contains(LogicActionKey) && e.Data[LogicActionKey] is int index) { found.Add(index); return found; }
        foreach (var p in (Errors.FindCoded(error)?.Problems ?? new JsonArray()).OfType<JsonObject>())
            if (p["pointer"]?.ToString() is { } pointer && ActionPointer.Match(pointer) is { Success: true } m && int.TryParse(m.Groups[1].Value, out var j) && j < actions.Count) found.Add(j);
        if (found.Count > 0) return found;
        var names = QuotedName.Matches(Errors.Text(error)).Select(m => m.Groups[1].Value).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var named = actions.Select((a, j) => (Name: a?["name"]?.ToString(), j)).Where(x => x.Name != null && names.Contains(x.Name)).Select(x => x.j).ToList();
        if (named.Count == 1) found.Add(named[0]);
        return found;
    }

    /// <summary>Removes what the failed attempt of the current op created (its anchors), so the op runs again on the model as
    /// it was before it. False when something could not be removed: the attempt then stays as a failure.</summary>
    private bool RollbackAttempt()
    {
        var created = _anchorJournal.Where(j => j.Created).Select(j => j.Target).OfType<IObjectSignature>().Distinct(ReferenceEqualityComparer.Instance).Cast<IObjectSignature>().ToList();
        var mine = created.ToHashSet(ReferenceEqualityComparer.Instance);
        var removed = new HashSet<IObjectSignature>(ReferenceEqualityComparer.Instance);
        try
        {
            foreach (var root in created.Where(o => !Ancestors(o).Any(mine.Contains)))
            {
                if (root.WasDeleted) continue;
                foreach (var d in root.GetAllDescendantsOfType<IObjectSignature>().Append(root)) removed.Add(d);
                root.Delete();
            }
        }
        catch { return false; }
        foreach (var alias in _handles.Where(h => h.Value is IObjectSignature sig && removed.Contains(sig)).Select(h => h.Key).ToArray()) _handles.Remove(alias);
        if (_byKey != null) foreach (var key in _byKey.Where(kv => removed.Contains(kv.Value)).Select(kv => kv.Key).ToArray()) _byKey.Remove(key);
        foreach (var o in removed) EsquecerApagado(o);
        for (var k = _anchorJournal.Count - 1; k >= 0; k--)
        {
            var (target, previous, isCreated) = _anchorJournal[k];
            if (isCreated) _anchors.Remove(target);
            else if (previous is { } before) _anchors[target] = before;
            else _anchors.Remove(target);
        }
        _anchorJournal.Clear();
        return true;

        static IEnumerable<object> Ancestors(IObjectSignature o) { for (var p = o.Parent; p != null; p = (p as IObjectSignature)?.Parent) yield return p; }
    }

    /// <summary>primeira-certa A6: a logic op with several actions failed. Its failed actions (and the actions of the op that
    /// use them) are left out and the op runs again, until it applies or no action is left; each round's failure is kept
    /// with the pointer of its action in the op as written. Null (the op fails whole, as before) for an op with fewer than
    /// two actions, a `replace` (a replaced action cannot be given back), keys besides actions, or a failure that names no
    /// action or whose writes cannot be removed.</summary>
    private Isolation? IsolateActions(JsonObject op, int index, Exception first, string? opsPointer, Action<string>? log)
    {
        if (op["data"] is not JsonObject data || data.Any(p => p.Key != "actions") || data["actions"] is not JsonArray all || all.Count < 2) return null;
        if (all.Any(a => a is not JsonObject o || o["name"]?.ToString() is not { Length: > 0 } || o["replace"] is JsonValue r && (!r.TryGetValue<bool>(out var replace) || replace))) return null;
        var map = Enumerable.Range(0, all.Count).ToList();
        var attempt = op;
        var error = first;
        var broken = new SortedSet<int>(); var dependents = new SortedSet<int>();
        var failures = new List<ApplyFailure>(); var warnings = new List<JsonObject>();
        var at = opsPointer == null ? null : $"{opsPointer}/{index}";
        for (var round = 0; round <= all.Count; round++)
        {
            var culprits = Culprits(error, attempt).Select(j => map[j]).ToList();
            if (culprits.Count == 0 || !RollbackAttempt())
            {
                if (round == 0) return null;
                // A later round failed without naming its action: the actions left fail together, as the op did.
                culprits = map.ToList();
                failures.Add(Failure(culprits));
                broken.UnionWith(culprits);
                break;
            }
            failures.Add(Failure(culprits));
            broken.UnionWith(culprits);
            // The actions of the op that use a failed one (by name, in any of their texts), transitively.
            for (var grew = true; grew;)
            {
                grew = false;
                var names = broken.Concat(dependents).Select(j => all[j]!["name"]!.ToString()).ToList();
                for (var j = 0; j < all.Count; j++)
                {
                    if (broken.Contains(j) || dependents.Contains(j) || Uses(all[j]!.AsObject(), names) is not { } used) continue;
                    dependents.Add(j); grew = true;
                    warnings.Add(JobPreflight.Problem(index, at == null ? null : $"{at}/data/actions/{j}", "APPLY_SKIPPED", "warning",
                        $"action '{all[j]!["name"]}' was left out of op #{index}: it uses '{used}', an action of the same op that failed",
                        $"fix '{used}'; this action applies with it", null, "logic"));
                }
            }
            map = Enumerable.Range(0, all.Count).Where(j => !broken.Contains(j) && !dependents.Contains(j)).ToList();
            if (map.Count == 0) break;
            attempt = op.DeepClone().AsObject();
            attempt["data"]!["actions"] = new JsonArray(map.Select(j => all[j]!.DeepClone()).ToArray());
            log?.Invoke($"#{index} logic again without action(s) {string.Join(", ", broken.Concat(dependents).Order())}");
            try { return new(failures, warnings, BrokenOp(), ApplyOne(attempt), new JsonArray(map.Select(j => (JsonNode)j).ToArray())); }
            catch (Exception ex) { error = ex; }
        }
        return new(failures, warnings, BrokenOp(), null, new JsonArray());

        // What later ops must not use: the failed actions and those left out with them.
        JsonObject BrokenOp() => new() { ["op"] = "logic", ["data"] = new JsonObject { ["actions"] = new JsonArray(broken.Concat(dependents).Order().Select(j => all[j]!.DeepClone()).ToArray()) } };

        // One round's failure: the problems of the attempt (pointers relative to the attempt) moved to the actions of the op
        // as written; a problem of the op as a whole is the failed action's.
        ApplyFailure Failure(List<int> culprits)
        {
            var text = $"op #{index} (logic {string.Join(", ", culprits.Select(j => all[j]!["name"]))}): {Unwrap(error)}";
            var failure = new ApplyFailure(index, "logic", attempt, new InvalidOperationException(text, error));
            var problems = ApplyProblems(failure, opsPointer).ToList();
            foreach (var p in problems)
            {
                p["phase"] ??= "apply";
                if (at == null) continue;
                var pointer = p["pointer"]?.ToString();
                if (pointer != null && pointer.StartsWith(at + "/data/actions/", StringComparison.Ordinal) && ActionPointer.Match(pointer[(at + "/data").Length..]) is { Success: true } m)
                    p["pointer"] = $"{at}/data/actions/{map[int.Parse(m.Groups[1].Value)]}" + pointer[(at + "/data").Length..][m.Length..];
                else if (culprits.Count == 1 && (pointer == null || pointer == at || pointer == at + "/data"))
                    p["pointer"] = $"{at}/data/actions/{culprits[0]}";
                if (p["patch"] is JsonArray patch)
                    foreach (var step in patch.OfType<JsonObject>())
                        if (step["path"]?.ToString() is { } path && path.StartsWith(at + "/data/actions/", StringComparison.Ordinal) && ActionPointer.Match(path[(at + "/data").Length..]) is { Success: true } pm)
                            step["path"] = $"{at}/data/actions/{map[int.Parse(pm.Groups[1].Value)]}" + path[(at + "/data").Length..][pm.Length..];
            }
            // The problems above are the refusal of this failure (ApplyRefusal), never the attempt's own pointers; a coded
            // failure keeps its code (A7: a lone refusal says LOGIC_INVALID as before), with these problems.
            Exception refusal = Errors.FindCoded(error) is { } coded && coded is not JobPreflightException
                ? new KernelRefusalException(coded.Code, text, new JsonArray(problems.Select(p => (JsonNode)JobPreflight.PublicProblem(p)).ToArray()))
                : new InvalidOperationException(text);
            return new ApplyFailure(index, "logic", op, refusal, problems);
        }

        static string? Uses(JsonObject action, List<string> names)
        {
            var texts = Texts(action).ToList();
            foreach (var name in names)
            {
                var word = new Regex(@"(?<![\p{L}\p{N}_$])" + Regex.Escape(name) + @"(?![\p{L}\p{N}_])", RegexOptions.IgnoreCase);
                if (texts.Any(t => word.IsMatch(t))) return name;
            }
            return null;
        }

        static IEnumerable<string> Texts(JsonNode? node, string? key = null)
        {
            switch (node)
            {
                case JsonValue v when v.TryGetValue<string>(out var s):
                    if (key is not ("description" or "label" or "name")) yield return s;
                    break;
                case JsonObject o:
                    foreach (var (k, child) in o) foreach (var s in Texts(child, k)) yield return s;
                    break;
                case JsonArray a:
                    foreach (var child in a) foreach (var s in Texts(child, key)) yield return s;
                    break;
            }
        }
    }

    // ---- the Verify, mapped to the job ------------------------------------------------------------------------------------

    private static readonly HashSet<string> ActionKinds = new(StringComparer.Ordinal)
        { "IServerAction", "IServiceAction", "IClientAction", "IScreenAction", "IPreparation", "IBlockAction", "IMobileScreenAction" };
    private static readonly Regex Quoted = new(@"'([\p{L}_][\p{L}\p{N}_.]*)'|""([\p{L}_][\p{L}\p{N}_.]*)""", RegexOptions.Compiled);
    private static readonly Regex RequiredInstead = new(@"'([^']+)'\s+(?:data type\s+)?(?:is\s+)?required instead of\s+'([^']+)'", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    /// <summary>One problem (phase "verify") per blocking message: the op whose write holds the message's element (the set
    /// that wrote the property the message is about, by its name or by the text of its expression; for a property no set
    /// wrote, the op that created its element; else the nearest anchored ancestor of its owner), the pointer as deep as the
    /// job lets it be (the action of a logic op and, when its text is in the job, the expression; the value of the set that
    /// wrote the property; the string of another op that holds the expression of the property the message names), the
    /// Verify id as the code, a fix, and the patch when the fix is certain (an unknown function one built-in certainly
    /// means). A message whose element no op of the job wrote keeps op and pointer null, with the element's path.</summary>
    public List<JsonObject> VerifyProblems(IReadOnlyList<MessageInfo> blocking, JsonArray ops, string? opsPointer, string lane, IReadOnlyDictionary<string, VerifyHint>? hints)
    {
        var problems = new List<JsonObject>();
        var patchSources = new Dictionary<int, JsonObject>();
        var patchedText = new Dictionary<string, string>(StringComparer.Ordinal);
        if (blocking.Count == 0) return problems;
        // One walk of the module for every message (the owners of expressions are not in the session's key map).
        Dictionary<string, IObjectSignature>? byKey = null;
        IObjectSignature? Owner(string? key)
        {
            if (string.IsNullOrEmpty(key)) return null;
            try
            {
                byKey ??= new KernelModelReader().Walk(_es).Concat(Descendants()).Where(d => d.ObjectKey != null && !d.WasDeleted)
                    .GroupBy(d => d.ObjectKey!.ToString()!).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
            }
            catch { return null; }
            return byKey.TryGetValue(key, out var o) ? o : null;
        }
        var omitted = new SortedSet<int>();
        foreach (var m in blocking)
        {
            // The owner the Verify gave (a CustomProperty is no child of its widget: the walk never finds it), else by its key.
            var owner = m.Owner is IObjectSignature { WasDeleted: false } given ? given : Owner(m.OwnerKey);
            int? op = null, failed = null;
            IObjectSignature? anchored = null;
            for (var o = owner; o != null && op == null && failed == null; o = o.Parent as IObjectSignature)
                if (_anchors.TryGetValue(o, out var i)) { op = i; anchored = o; }
                else if (_failedAnchors.TryGetValue(o, out var f)) failed = f;
            // An owner the walk does not reach (an expression of a widget an html edit kept): the screen that holds it, when an op
            // wrote that screen.
            if (op == null && failed == null && Owner(m.ScreenKey) is { } screen)
                if (_anchors.TryGetValue(screen, out var s)) op = s;
                else if (_failedAnchors.TryGetValue(screen, out var f)) failed = f;
            // What a failed op left half-built: its failure is already a problem of the apply.
            if (failed is { } failedOp) { omitted.Add(failedOp); continue; }
            // The property the message is about, when a set of this job wrote it, is that set's (the anchor of the widget is
            // the last op that touched it: the Values of a Dropdown pointed at the set of its Labels, or nowhere). The Verify
            // may name it by its model name, not the one the set used (the StyleClasses of a Text is its Style): then the set
            // on the owner whose value is the text of that expression. A property no set wrote is never the set of another
            // property (an html fragment wrote the Values, then a set wrote the Labels): it is the op that created its
            // element, else that set alone, never its value.
            var alone = false;
            if (owner != null && PropertySet(owner, anchored, m, ops) is { } written) op = written;
            else if (owner != null && SetOfText(owner, m, ops) is { } same) op = same;
            else if (owner != null && op is { } last && last < ops.Count && ops[last] is JsonObject touched && touched["op"]?.ToString() == "set"
                && (m.Properties is { Count: > 0 } || PropertyObjects(owner, anchored).Any()))
            {
                if (CreatorOf(owner) is { } creator) op = creator;
                else alone = true;
            }
            var source = op is { } index && index < ops.Count ? ops[index] as JsonObject : null;
            var kind = source?["op"]?.ToString();
            var pointer = op is { } at && opsPointer != null ? $"{opsPointer}/{at}" : null;
            var sourcePointer = pointer;
            string? inner = null;
            JsonObject? action = null;
            if (!alone && kind == "logic" && owner != null && ActionOf(owner, source!) is { } found)
            {
                action = found.Declaration;
                if (pointer != null)
                {
                    pointer += $"/data/actions/{found.Index}";
                    if (ExpressionPointer(owner, m, found.Declaration, found.Action) is { } deeper) { inner = $"/data/actions/{found.Index}{deeper}"; pointer += deeper; }
                }
            }
            else if (!alone && kind == "logic" && owner != null && pointer != null && TextOf(owner, source!) is { } flowText) pointer += "/data" + flowText;
            else if (!alone && kind == "set" && source!["value"] != null && pointer != null) { inner = "/value"; pointer += "/value"; }
            else if (!alone && kind != "logic" && source != null && pointer != null && owner != null && PropertyPointer(owner, m, source) is { } held) { inner = held; pointer += held; }
            var patchSource = op is { } sourceIndex && source != null
                ? patchSources.TryGetValue(sourceIndex, out var editedSource) ? editedSource : patchSources[sourceIndex] = source.DeepClone().AsObject()
                : source;
            var modelPatch = ModelSourcePatch(m, owner, patchSource, sourcePointer);
            if (modelPatch is { } edit && patchSource != null && sourcePointer != null)
                RememberSourceEdits(patchSource, sourcePointer, edit.Patch, patchedText);
            var patch = modelPatch ?? (inner != null && pointer != null && Text(source, inner) is { } text ? CertainPatch(m, pointer, text) : null);
            var message = $"{m.Type} {m.Id}: {VerifyHints.OneLine(m.Detail, 400)} @ {m.Path}";
            var problem = JobPreflight.Problem(op, pointer, m.Id, "error", message, patch?.Fix ?? Fix(m, owner, action, source, lane, hints), patch?.Patch, kind ?? "verify");
            problem["phase"] = "verify";
            problem["element"] = m.Path;
            if (m.OwnerKey != null) problem["key"] = m.OwnerKey;
            // a message on an element a prototype op generated names its capture k (1.4.1: the facade degrades that item)
            if (PrototypeOrigin(owner) is { } origin) { problem["k"] = origin.K; problem["widgetKey"] = origin.Key; }
            problems.Add(problem);
        }
        // Several Verify messages can repair the same HTML or flow item. Each problem carries the complete combined edit,
        // so applying every offered patch is order-independent and cannot discard another correction.
        foreach (var problem in problems)
            foreach (var edit in (problem["patch"] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
                if (edit["path"]?.ToString() is { } path && patchedText.TryGetValue(path, out var finalText)) edit["value"] = finalText;
        if (omitted.Count > 0)
            problems.Add(JobPreflight.Problem(null, null, "VERIFY_OF_FAILED_OPS_OMITTED", "warning",
                $"the Verify messages on what failed op(s) #{string.Join(", #", omitted)} left half-built are not reported: they are those failures again",
                "fix the failed ops; their Verify comes with the next apply", null, "verify"));
        return problems;
    }

    /// <summary>The declared action (index in the op's data.actions) that holds <paramref name="owner"/>: the nearest action
    /// ancestor whose name the op declares (the owner name decides between two screen actions of the same name).</summary>
    private static (int Index, JsonObject Declaration, IObjectSignature Action)? ActionOf(IObjectSignature owner, JsonObject op)
    {
        var declared = op["data"]?["actions"] as JsonArray;
        if (declared == null) return null;
        for (var o = owner; o != null; o = o.Parent as IObjectSignature)
        {
            var type = o.GetInterface()?.Name ?? "";
            if (!ActionKinds.Contains(type) && !type.EndsWith("Action", StringComparison.Ordinal)) continue;
            var name = TypeResolver.Name(o) ?? "";
            var parent = o.Parent is IObjectSignature p ? TypeResolver.Name(p) ?? "" : "";
            var matches = declared.Select((a, n) => (Action: a as JsonObject, n)).Where(x => x.Action != null
                && string.Equals(x.Action["name"]?.ToString(), name, StringComparison.OrdinalIgnoreCase)).ToList();
            if (matches.Count > 1)
                matches = matches.Where(x => Preflight.JobFacts.Owner(x.Action!) is var owned && (owned == "@espace" || owned.EndsWith(":" + parent, StringComparison.OrdinalIgnoreCase) || owned.EndsWith("/" + parent, StringComparison.OrdinalIgnoreCase))).ToList();
            if (matches.Count > 0) return (matches[0].n, matches[0].Action!, o);
        }
        return null;
    }

    /// <summary>The model keys of an element and of every element above it, the element first (the patch round of JobRunner: a
    /// Verify message under a node a fix wrote is that fix's). Empty when no element has the key.</summary>
    internal List<string> KeyChain(string key)
    {
        try
        {
            // One walk for every message of the round (the model does not change once the round's job is applied).
            _keyChainIndex ??= new KernelModelReader().Walk(_es).Concat(Descendants()).Where(d => !d.WasDeleted && d.ObjectKey != null)
                .GroupBy(d => d.ObjectKey!.ToString()!).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        }
        catch { _keyChainIndex = new(StringComparer.Ordinal); }
        var found = _keyChainIndex.GetValueOrDefault(key);
        var chain = new List<string>();
        for (var o = found; o != null; o = o.Parent as IObjectSignature)
            if (o.ObjectKey?.ToString() is { } k) chain.Add(k);
        return chain;
    }

    private Dictionary<string, IObjectSignature>? _keyChainIndex;

    /// <summary>The text of a logic op in the text form (its pointer under data: /flow, /flow/j) whose action holds
    /// <paramref name="owner"/>: the nearest action ancestor named by the header of one text of the op.</summary>
    private static string? TextOf(IObjectSignature owner, JsonObject op)
    {
        if (op["data"] is not JsonObject data || !data.ContainsKey("flow")) return null;
        List<(string Text, string? BasedOn, string Pointer)> texts;
        try { texts = FlowTextForm.Texts(data); } catch (Exception) { return null; }
        var names = texts.Select(t => { try { return Anvil.Reading.ModuleFlow.Read(t.Text).Name; } catch (FormatException) { return ""; } }).ToList();
        for (var o = owner; o != null; o = o.Parent as IObjectSignature)
        {
            var type = o.GetInterface()?.Name ?? "";
            if (!ActionKinds.Contains(type) && !type.EndsWith("Action", StringComparison.Ordinal)) continue;
            var at = names.FindIndex(n => string.Equals(n, TypeResolver.Name(o), StringComparison.OrdinalIgnoreCase));
            if (at >= 0) return texts[at].Pointer;
        }
        return null;
    }

    /// <summary>The pointer, relative to the declared action, of the expression the message is about: the text of the
    /// owner's expressions (or the quoted expression of the message's path) found as a string of the declaration. Null when
    /// the text is not in the job as written (the compiler rewrote it) or appears in more than one place.</summary>
    private static string? ExpressionPointer(IObjectSignature owner, MessageInfo m, JsonObject declaration, IObjectSignature action)
    {
        var texts = new List<string>();
        for (var o = owner; o != null && !ReferenceEquals(o, action); o = o.Parent as IObjectSignature)
        {
            if (o is IExpression own && Safe(() => own.Text) is { Length: > 0 } t) texts.Add(t);
            foreach (var property in o.GetType().GetProperties().Where(p => typeof(IExpression).IsAssignableFrom(p.PropertyType) && p.GetIndexParameters().Length == 0))
                if (Safe(() => (property.GetValue(o) as IExpression)?.Text) is { Length: > 0 } text) texts.Add(text);
            if (texts.Count > 0) break;
        }
        var quoted = Regex.Match(m.Path, "\"(.*)\"\\s*$");
        if (quoted.Success) texts.Insert(0, quoted.Groups[1].Value);
        foreach (var text in texts.Distinct(StringComparer.Ordinal))
        {
            var wanted = NormalText(text.EndsWith("...", StringComparison.Ordinal) ? text[..^3] : text);
            var prefix = text.EndsWith("...", StringComparison.Ordinal);
            var found = Strings(declaration, "").Where(s => prefix ? NormalText(s.Text).StartsWith(wanted, StringComparison.Ordinal) : NormalText(s.Text) == wanted).Select(s => s.Pointer).Distinct().ToList();
            if (found.Count == 1) return found[0];
        }
        return null;

        static string? Safe(Func<string?> read) { try { return read(); } catch { return null; } }
    }

    /// <summary>The top-level set of this job that wrote the property a message is about: a property object between the owner
    /// and its anchored ancestor (no child of its parent: a CustomProperty such as the Values of a Dropdown) under the name
    /// the set gave on that parent, or a property of the owner the message names (the Condition of an If). An op that writes
    /// its widgets' properties itself (html, screen) is no such set: its widgets keep their anchor.</summary>
    private int? PropertySet(IObjectSignature owner, IObjectSignature? anchored, MessageInfo m, JsonArray ops)
    {
        var candidates = (m.Properties ?? []).Select(name => ((object)owner, name)).Concat(PropertyObjects(owner, anchored).Select(p => ((object)p.Parent, p.Name)));
        foreach (var candidate in candidates)
            if (_propertyAnchors.TryGetValue(candidate, out var i) && i < ops.Count && ops[i] is JsonObject set && set["op"]?.ToString() == "set"
                && string.Equals(set["prop"]?.ToString(), candidate.Item2, StringComparison.OrdinalIgnoreCase))
                return i;
        return null;
    }

    /// <summary>The property objects between the owner and its anchored ancestor (no child of their parent: a CustomProperty
    /// such as the Values of a Dropdown), each with its parent and the name it has there.</summary>
    private static IEnumerable<(IObjectSignature Parent, string Name)> PropertyObjects(IObjectSignature owner, IObjectSignature? anchored)
    {
        for (var o = owner; o != null && !ReferenceEquals(o, anchored); o = o.Parent as IObjectSignature)
            if (o.Parent is IObjectSignature parent && TypeResolver.Name(o) is { Length: > 0 } name && !parent.Children.OfType<object>().Any(c => ReferenceEquals(c, o)))
                yield return (parent, name);
    }

    /// <summary>The top-level set of this job on the owner itself whose value is the text of the expression of a property the
    /// message names, compared as <see cref="PropertyPointer"/> compares (NormalText): the Verify names some properties by
    /// their model name, not by the name the set used (a set of StyleClasses on a Text is its Style). Null when no set of the
    /// owner holds that text, or more than one does.</summary>
    private int? SetOfText(IObjectSignature owner, MessageInfo m, JsonArray ops)
    {
        var texts = (m.Properties ?? []).Select(name => PropertyText(owner, name)).OfType<string>().Where(t => !string.IsNullOrWhiteSpace(t))
            .Select(NormalText).ToHashSet(StringComparer.Ordinal);
        if (texts.Count == 0) return null;
        var found = _propertyAnchors.Where(a => ReferenceEquals(a.Key.Target, owner)).Where(a => a.Value < ops.Count && ops[a.Value] is JsonObject set
                && set["op"]?.ToString() == "set" && string.Equals(set["prop"]?.ToString(), a.Key.Prop, StringComparison.OrdinalIgnoreCase)
                && set["value"] is JsonValue value && value.TryGetValue<string>(out var text) && texts.Contains(NormalText(text)))
            .Select(a => a.Value).Distinct().ToList();
        return found.Count == 1 ? found[0] : null;
    }

    /// <summary>The text of the expression <paramref name="owner"/>.<paramref name="name"/>, or null.</summary>
    private static string? PropertyText(IObjectSignature owner, string name)
    {
        try { return (ModelHost.Prop(owner, name) as IExpression)?.Text; } catch { return null; }
    }

    /// <summary>The op of this job that created the owner or its nearest created ancestor (the html fragment that created a
    /// Dropdown with its Values), or null when the job created none of them.</summary>
    private int? CreatorOf(IObjectSignature owner)
    {
        for (var o = owner; o != null; o = o.Parent as IObjectSignature)
            if (_creators.TryGetValue(o, out var op)) return op;
        return null;
    }

    /// <summary>The pointer, relative to an op that is not a logic op, of the expression of the property the message names
    /// (the Condition of an If, the ValueExpression of the CustomProperty of an Expression), when the op holds that text as
    /// exactly one of its strings (the binding of an html page op). Null otherwise: the op stays the place.</summary>
    private static string? PropertyPointer(IObjectSignature owner, MessageInfo m, JsonObject source)
    {
        foreach (var name in m.Properties ?? [])
        {
            var text = PropertyText(owner, name);
            if (string.IsNullOrWhiteSpace(text)) continue;
            var wanted = NormalText(text);
            var found = Strings(source, "").Where(s => NormalText(s.Text) == wanted).Select(s => s.Pointer).Distinct().ToList();
            if (found.Count == 1) return found[0];
        }
        return null;
    }

    private static string NormalText(string s) => Regex.Replace(s, @"\s+", " ").Trim();

    /// <summary>The string at <paramref name="pointer"/> (relative to <paramref name="node"/>), or null.</summary>
    private static string? Text(JsonNode? node, string pointer)
    {
        foreach (var segment in pointer.Split('/').Skip(1).Select(s => s.Replace("~1", "/").Replace("~0", "~")))
            node = node switch
            {
                JsonObject o => o[segment],
                JsonArray a when int.TryParse(segment, out var k) && k >= 0 && k < a.Count => a[k],
                _ => null,
            };
        return node is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
    }

    /// <summary>The fix and the patch of a message whose correction is certain from the job alone: an unknown function one
    /// built-in certainly means (FunctionCatalog.Certain, Lower -> ToLower), renamed in the expression at the pointer (a set
    /// value the base check does not read). Null when the correction is not certain.</summary>
    private static (string Fix, JsonArray Patch)? CertainPatch(MessageInfo m, string pointer, string text)
    {
        if (m.Id != "ExpressionUnknownFunction" || Quoted.Match(m.Detail) is not { Success: true } quoted) return null;
        var name = quoted.Groups[1].Success ? quoted.Groups[1].Value : quoted.Groups[2].Value;
        // No catalog in this host (it is read from the Studio's registry): no certain fix, the message keeps its advice.
        string? certain;
        try { certain = FunctionCatalog.Certain(name); } catch { certain = null; }
        if (certain == null) return null;
        var renamed = JobRunner.RenameCall(text, name, certain);
        return renamed == text ? null
            : ($"write {certain}(...), the built-in meant here (same arguments)", new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = pointer, ["value"] = renamed }));
    }

    private static IEnumerable<(string Pointer, string Text)> Strings(JsonNode? node, string at)
    {
        switch (node)
        {
            case JsonValue v when v.TryGetValue<string>(out var s): yield return (at, s); break;
            case JsonObject o:
                foreach (var (key, child) in o)
                    if (key is not ("description" or "name" or "label" or "as" or "type"))
                        foreach (var x in Strings(child, at + "/" + key.Replace("~", "~0").Replace("/", "~1"))) yield return x;
                break;
            case JsonArray a:
                for (var k = 0; k < a.Count; k++) foreach (var x in Strings(a[k], at + "/" + k)) yield return x;
                break;
        }
    }

    /// <summary>The fix of a blocking Verify message, the advice itself (never a command the app session cannot run): for an
    /// unknown name, the names in scope of the action, the item scope of a Dropdown's Values and Labels (and of the type
    /// 'None' its expression then has), the names of the page, or the scope of what holds the element (action, screen,
    /// block, module); for a required argument, its name; for a type mismatch, the conversion built-in when the lane has it;
    /// else the curated hint, else what to do with the message.</summary>
    private static string Fix(MessageInfo m, IObjectSignature? owner, JsonObject? action, JsonObject? source, string lane, IReadOnlyDictionary<string, VerifyHint>? hints)
    {
        var text = m.Detail + " " + m.Path;
        switch (m.Id)
        {
            case "ExpressionUnknownObject" or "InvalidVariable_UnknownObjInVar" when action != null:
            {
                var scope = new[] { "inputs", "outputs", "vars" }.SelectMany(s => (action[s] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
                    .Select(p => p["name"]?.ToString()).OfType<string>().Concat(Preflight.LogicScan.Of(action).Nodes.Keys).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
                var unknown = Quoted.Matches(m.Detail).Select(q => q.Groups[1].Success ? q.Groups[1].Value : q.Groups[2].Value).FirstOrDefault(n => !scope.Contains(n, StringComparer.OrdinalIgnoreCase));
                var name = action["name"]?.ToString();
                IReadOnlyList<string> close = unknown == null ? [] : NameSuggestions.Closest(unknown.Split('.').First(), scope);
                return close.Count > 0 ? $"use {string.Join(", ", close)}, or declare '{unknown}' in {name} (inputs/vars)"
                    : $"the names in scope of {name} are {string.Join(", ", scope.Take(15))}{(scope.Count > 15 ? ", ..." : "")}; declare the name (inputs/vars), name the node that produces it, or qualify it (Site., Entities.)";
            }
            // The Values and Labels of a Dropdown (UI-Mockup, FarmaVirtual call 99): an unknown name there, and the CustomObjectError
            // of the type its expression then lacks ('...' required instead of 'None'), are the item scope (DropdownItemScopeRules
            // refuses List.Current before). A CustomObjectError of another type is a wrong type, not the scope: its curated hint.
            case "ExpressionUnknownObject" when DropdownItem(owner) is { } property:
                return ItemScope(property);
            case "CustomObjectError" when DropdownItem(owner) is { } property && RequiredInstead.Match(text) is { Success: true } untyped
                && string.Equals(untyped.Groups[2].Value, "None", StringComparison.Ordinal):
                return ItemScope(property);
            case "ExpressionUnknownObject" when Unknown(m) is { } unknown && PageNames(source) is { Count: > 0 } names:
            {
                IReadOnlyList<string> close = NameSuggestions.Closest(unknown.Split('.').First(), names);
                return close.Count > 0 ? $"use {string.Join(", ", close)}, or declare '{unknown}' in the vars of the page"
                    : $"the names of the page are {string.Join(", ", names.Take(15))}{(names.Count > 15 ? ", ..." : "")}; declare '{unknown}' in its vars or sources, or qualify it (Site., Entities.)";
            }
            case "ExpressionUnknownObject" when Unknown(m) is { } unknown:
                return $"'{unknown}' is no name in scope of this element: use {ScopeOf(owner)}, declare it, or qualify it (Site., Entities.)";
            case "ArgumentRequiredExpression" when owner != null && TypeResolver.Name(owner) is { Length: > 0 } argument:
                return $"give the argument '{argument}' a value (\"args\": {{\"{argument}\": \"<expression>\"}} in the call), or make that input not mandatory";
            case "ExpressionInvalidExpressionType" or "OperatorIncompatibleTypes" when RequiredInstead.Match(text) is { Success: true } types:
            {
                var (wanted, given) = (types.Groups[1].Value, types.Groups[2].Value);
                var function = $"{Short(given)}To{Short(wanted)}";
                return Preflight.Builtins.Get(function, lane) is { } builtin
                    ? $"the value is {given} and {wanted} is required: convert it with {builtin.Name}(...), or use a value of type {wanted}"
                    : $"the value is {given} and {wanted} is required: write a value of type {wanted} (no built-in {function} in this Studio)";
            }
        }
        return VerifyHints.Fix(m.Id, hints) ?? $"correct the element at the pointer as the message says ({m.Id} has no curated advice)";

        static string Short(string type) => type.Trim().EndsWith(" Identifier", StringComparison.OrdinalIgnoreCase) ? "Identifier" : type.Replace(" ", "");
    }

    /// <summary>"Values" or "Labels" when the owner is that property (a CustomProperty) of a Dropdown, else null.</summary>
    private static string? DropdownItem(IObjectSignature? owner)
        => owner?.Parent is IObjectSignature widget && Implements(widget, "IDropdown") && TypeResolver.Name(owner) is "Values" or "Labels" ? TypeResolver.Name(owner) : null;

    /// <summary>The item scope of the Values or Labels of a Dropdown.</summary>
    private static string ItemScope(string property)
        => $"the {property} of a Dropdown is evaluated per element of its List and reads only that element's attributes: "
            + "Entity.Attribute for an aggregate (User.Id), Attribute for a list of records (Id); never the List itself, its Current, nor a screen variable";

    /// <summary>Where the names in scope of an element come from, by what holds it: its action (inputs, outputs and local
    /// variables), its screen or its block (variables, inputs, aggregates and data actions), else the module (a block widget
    /// or an action is no screen's: "of its screen" sent the author to the wrong place).</summary>
    private static string ScopeOf(IObjectSignature? owner)
    {
        var scopes = new List<string>();
        for (var o = owner; o != null; o = o.Parent as IObjectSignature)
        {
            var type = o.GetInterface()?.Name ?? "";
            if (scopes.Count == 0 && (ActionKinds.Contains(type) || type.EndsWith("Action", StringComparison.Ordinal)))
                scopes.Add("an input, output or local variable of its action");
            else if (ModelHost.IsScreen(o) || Implements(o, "IMobileBlock") || Implements(o, "IWebBlock"))
            {
                scopes.Add($"a variable, input, aggregate or data action of its {(ModelHost.IsScreen(o) ? "screen" : "block")}");
                break;
            }
        }
        return scopes.Count > 0 ? string.Join(", or ", scopes) : "a name of the module (an entity, a structure, a static record, a site property)";
    }

    /// <summary>The first name the message quotes (the unknown name of ExpressionUnknownObject), or null.</summary>
    private static string? Unknown(MessageInfo m)
        => Quoted.Matches(m.Detail).Select(q => q.Groups[1].Success ? q.Groups[1].Value : q.Groups[2].Value).FirstOrDefault();

    /// <summary>The names an html page op declares (its vars and the aliases of its sources), or null for another op.</summary>
    private static List<string>? PageNames(JsonObject? source)
    {
        if (source?["op"]?.ToString() != "html" || source["parent"] != null || source["data"] is not JsonObject data) return null;
        var sources = (data["sources"] as JsonArray ?? new JsonArray()).Append(data["source"]).OfType<JsonObject>();
        return (data["vars"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().Select(v => v["name"]?.ToString())
            .Concat(sources.Select(s => s["as"]?.ToString())).OfType<string>().Where(n => n.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
    }
}
