using System.Text.Json.Nodes;
using Anvil.Reading;
using OutSystems.Model;
using ServiceStudio.Model;

namespace Anvil.Core;

/// <summary>
/// R2-B (one round, MINERACAO F2): a part of a job that fails never stops the parts that do not need it, and the parts that need
/// it are judged against what it declares. A text of a logic op that fails (its plan, or its write) is refused with its own
/// problems, and the action it declares is written as its stub: the header and the parameters of the text, an empty body. The
/// other texts of the op are written as usual, so the Verify judges them, and a text (or a later op) that calls the failed
/// action is written against that stub and judged for its own faults. What a stub or a failed text left in the model is the
/// failure again (failed anchors: the Verify's messages there are never news). A text no stub can stand for (an edit of an
/// action by its key) is left out; what uses it is a consequence of its failure, as before.
/// </summary>
public sealed partial class ModelSession
{
    // While Apply runs a logic op in the text form with KeepFailures: the op keeps going after a failed text (its stub instead)
    // and hands the refusal of its texts back here instead of throwing it.
    private bool _flowKeepFailures;
    private KernelRefusalException? _flowKeptRefusal;
    private List<(string Text, string Pointer)>? _flowLeftOut;

    /// <summary>The stub of an action text: its header (and the @{...} line of its properties), its in and out parameters with
    /// their descriptions and continuation lines, and an empty body. Null for a text with no header, a header with a key (an
    /// edit of an action of the module: no stub stands for it) or a stub that does not read.</summary>
    internal static string? StubText(string text)
    {
        var lines = text.Replace("\r\n", "\n").Split('\n');
        var at = 0;
        while (at < lines.Length && (lines[at].Trim().Length == 0 || lines[at].TrimStart().StartsWith("///", StringComparison.Ordinal))) at++;
        if (at >= lines.Length) return null;
        var header = lines[at].TrimEnd();
        if (FlowSyntax.SplitKey(header, out _, out var key) && key.Length > 0) return null;
        if (FlowTextForm.Header(header) is not { Name.Length: > 0 }) return null;
        var kept = new List<string> { header };
        string? description = null;
        var inParameter = false;
        for (at++; at < lines.Length; at++)
        {
            var line = lines[at];
            var content = line.TrimStart(' ');
            if (content.Trim().Length == 0) continue;
            var depth = (line.Length - content.Length) / 2;
            if (depth > 1) { if (inParameter) kept.Add(line.TrimEnd()); continue; }
            if (depth < 1) break;
            inParameter = false;
            if (content.StartsWith("///", StringComparison.Ordinal)) { description = line.TrimEnd(); continue; }
            if (content.StartsWith("@{", StringComparison.Ordinal)) { kept.Add(line.TrimEnd()); description = null; continue; }
            if (content.StartsWith("in ", StringComparison.Ordinal) || content.StartsWith("out ", StringComparison.Ordinal))
            {
                if (description != null) kept.Add(description);
                kept.Add(line.TrimEnd());
                description = null;
                inParameter = true;
                continue;
            }
            // Events and locals are the body's; the first statement ends the signature.
            if (content.StartsWith("local ", StringComparison.Ordinal) || content.StartsWith("on ", StringComparison.Ordinal) && !content.StartsWith("on exception ", StringComparison.Ordinal))
            { description = null; continue; }
            break;
        }
        foreach (var candidate in new[] { string.Join("\n", kept) + "\n  end\n", header + "\n  end\n" })
        {
            try { ModuleFlow.Read(candidate); return candidate; }
            catch (FormatException) { }
        }
        return null;
    }

    // What a stub of the JSON form keeps of an action: who it is and what it takes and gives.
    private static readonly string[] StubKeys = ["name", "kind", "owner", "public", "function", "description", "inputs", "outputs", "fetch"];

    /// <summary>The stub of the actions of a logic op in the JSON form (data.actions; <paramref name="only"/>: those indices):
    /// each new action with its name, kind, owner, flags and parameters, and no body. Null when no action can have one (an op
    /// with other keys, an action that replaces an action of the module).</summary>
    internal static JsonObject? StubOp(JsonObject op, IEnumerable<int>? only = null)
    {
        if (op["op"]?.ToString() != "logic" || op["data"] is not JsonObject data || data.Any(p => p.Key != "actions") || data["actions"] is not JsonArray actions) return null;
        var stubs = new JsonArray();
        foreach (var j in only ?? Enumerable.Range(0, actions.Count))
        {
            if (j < 0 || j >= actions.Count || actions[j] is not JsonObject action || action["name"]?.ToString() is not { Length: > 0 }) return null;
            if (action["replace"] is JsonValue r && (!r.TryGetValue<bool>(out var replace) || replace)) return null;
            var stub = new JsonObject(action.Where(p => StubKeys.Contains(p.Key)).Select(p => KeyValuePair.Create(p.Key, p.Value?.DeepClone())));
            stub["steps"] = new JsonArray();
            stubs.Add(stub);
        }
        return stubs.Count == 0 ? null : new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["actions"] = stubs } };
    }

    /// <summary>Applies a stub op inside the current op: what it creates is the failure's (failed anchors). False, with what it
    /// created removed (or, when that cannot be, left as the failure's), when the stub does not apply.</summary>
    private bool ApplyStub(JsonObject stub)
    {
        var mark = _anchorJournal.Count;
        try { ApplyOne(stub); FailSince(mark); return true; }
        catch
        {
            var created = _anchorJournal.Skip(mark).Where(j => j.Created).Select(j => j.Target).OfType<IObjectSignature>().ToList();
            var mine = created.ToHashSet(ReferenceEqualityComparer.Instance);
            foreach (var root in created.Where(o => !(o.Parent is IObjectSignature p && mine.Contains(p))))
                if (!root.WasDeleted && !DeleteHalfBuilt(root)) break;
            FailSince(mark);
            return false;
        }
    }

    /// <summary>The refusal of the texts of the op Apply just ran (and the texts left out, whose names are blocked), once.</summary>
    private (KernelRefusalException Refusal, List<(string Text, string Pointer)> LeftOut)? TakeFlowRefusal()
    {
        if (_flowKeptRefusal is not { } refusal) return null;
        var left = _flowLeftOut ?? [];
        _flowKeptRefusal = null; _flowLeftOut = null;
        return (refusal, left);
    }

    /// <summary>What the current op wrote since <paramref name="mark"/> (an entry of its anchor journal) is a failure: what it
    /// created becomes a failed anchor, what it touched goes back to its previous anchor.</summary>
    private void FailSince(int mark)
    {
        if (_anchorOp is not { } op || mark >= _anchorJournal.Count) return;
        for (var k = _anchorJournal.Count - 1; k >= mark; k--)
        {
            var (target, previous, created) = _anchorJournal[k];
            if (created) { _anchors.Remove(target); _creators.Remove(target); _failedAnchors[target] = op; }
            else if (previous is { } before) _anchors[target] = before;
            else _anchors.Remove(target);
        }
        _anchorJournal.RemoveRange(mark, _anchorJournal.Count - mark);
    }

    /// <summary>An element and everything under it belong to a failure of the current op (a stub, a half-written action).</summary>
    private void FailSubtree(IObjectSignature root)
    {
        if (_anchorOp is not { } op) return;
        foreach (var o in root.GetAllDescendantsOfType<IObjectSignature>().Append(root))
        {
            _anchors.Remove(o); _creators.Remove(o);
            _failedAnchors[o] = op;
        }
    }

    /// <summary>Removes an action a failed text created half-built (so its stub takes its name). False when it cannot.</summary>
    private bool DeleteHalfBuilt(IObjectSignature action)
    {
        var removed = new HashSet<IObjectSignature>(action.GetAllDescendantsOfType<IObjectSignature>().Append(action), ReferenceEqualityComparer.Instance);
        try { if (!action.WasDeleted) action.Delete(); }
        catch { return false; }
        foreach (var alias in _handles.Where(h => h.Value is IObjectSignature sig && removed.Contains(sig)).Select(h => h.Key).ToArray()) _handles.Remove(alias);
        if (_byKey != null) foreach (var k in _byKey.Where(kv => removed.Contains(kv.Value)).Select(kv => kv.Key).ToArray()) _byKey.Remove(k);
        foreach (var o in removed) EsquecerApagado(o);
        return true;
    }

    /// <summary>A text whose write failed: what it wrote is the failure's; a new action (or the shell of a document of this job)
    /// is written again as its stub so the texts and ops that call it are judged; an edit of an action by its key is left out.
    /// <paramref name="number"/>: the count of written texts before it (its aliases are FlowDiff.AliasPrefix + number + 1).</summary>
    private void StubFailedText(int index, int mark, int number, FlowPlan plan, (string Text, string? BasedOn, string Pointer) text,
        string?[] stubs, SortedSet<int> leftOut, JsonNode?[] results)
    {
        IObjectSignature? half = null;
        if (plan.Baseline == null && !plan.Shell && _handles.TryGetValue(FlowDiff.AliasPrefix + (number + 1) + ".action", out var made)
            && made is IObjectSignature action && _anchorJournal.Skip(mark).Any(j => j.Created && ReferenceEquals(j.Target, action))) half = action;
        FailSince(mark);
        if ((plan.Baseline == null || plan.Shell) && StubText(text.Text) is { } stub && WriteStub(stub, text.Pointer, half) is { } key)
        {
            stubs[index] = stub;
            results[index] = new JsonObject { ["key"] = key, ["stub"] = true };
            return;
        }
        if (half is { WasDeleted: false }) FailSubtree(half);
        else if (plan.Action is { WasDeleted: false } written) FailSubtree(written);
        leftOut.Add(index);
    }

    /// <summary>Writes the stub of a failed text in the place of its action: the action the text created half-built goes first;
    /// the stub and what is under it are the failure's. Its key, or null when no stub could be written (the text is left out).</summary>
    private string? WriteStub(string stub, string pointer, IObjectSignature? halfBuilt)
    {
        if (halfBuilt != null && !DeleteHalfBuilt(halfBuilt)) return null;
        var written = FlowTextsWritten.Count;
        var mark = _anchorJournal.Count;
        try
        {
            var result = ApplyFlowText(stub, null, pointer);
            if (FlowTextsWritten.Count > written) FlowTextsWritten.RemoveRange(written, FlowTextsWritten.Count - written);
            FailSince(mark);
            if (result["key"]?.ToString() is not { Length: > 0 } key) return null;
            if (Resolve("@" + key) is IObjectSignature action) { FailSubtree(action); RefreshFlowActionIndexes(action); }
            return key;
        }
        catch
        {
            if (FlowTextsWritten.Count > written) FlowTextsWritten.RemoveRange(written, FlowTextsWritten.Count - written);
            FailSince(mark);
            return null;
        }
    }
}
