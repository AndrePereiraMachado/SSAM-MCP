using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>
/// The patch round (the review of 2026-10-12, after the four blockers): a refusal for an owner's rule (T1/T2, decision 6, T3,
/// the rules of a page) came alone, hiding what the rest of the job still had wrong (a Verify error of another action of the
/// same op, of another element of the same edit), and offered patches nothing had applied (a mapping the platform wrote twice,
/// an empty one, a button left without On Click, a client action on a name the Studio renamed). Before the refusal is
/// answered, the job runs again on a fresh copy of the base, its phases and its Verify, with every patch of the refusal
/// written in and the texts of a logic op that no patch fixes left out (the rest of the op, without what uses them). Then:
/// <list type="bullet">
/// <item>a problem of a part no patch changed, that the refusal does not already say, is a problem of the job the refusal
/// could not see: it joins the refusal (afterPatch: true);</item>
/// <item>a problem of a part a patch wrote (a corrected text that does not apply or read back, a Verify error under a node a
/// fix wrote or in a client action a fix created, a changed op the platform refuses) is the patch's: that op's patch is not
/// offered, its problems keep the written fix and say why.</item>
/// </list>
/// Nothing of the round is kept; a round that cannot run leaves the refusal as it was. It never runs inside itself.
/// </summary>
public static partial class JobRunner
{
    private static readonly HashSet<string> OwnerRuleCodes = new(StringComparer.Ordinal)
        { "NAME_COLLISION", "FLOW_FOREACH_LIST_ACTION", "FLOW_JAVASCRIPT_NOT_ISOLATED", QueryInLoopRule.Code, "HTML_SCRIPT", "HTML_VISIBLE", "HTML_FOREACH", "HTML_JSON" };

    /// <summary>The job of the round and what it found, each problem with whether a patch caused it.</summary>
    private sealed class Probe
    {
        public required string OpsPointer;
        /// <summary>The ops of the job as sent and as the round applies them.</summary>
        public required JsonArray Original, Applied;
        /// <summary>For each logic op in the text form: each text of the round with its index in the op as sent (-1: a text a
        /// patch added), whether a patch changed it and the text as sent.</summary>
        public required Dictionary<int, List<(int Original, bool Changed, string Text, string? Before)>> Texts;
        /// <summary>The ops the patches changed.</summary>
        public required HashSet<int> Changed;
        /// <summary>The actions of the texts left out (no patch fixes them, or they use one that is left out).</summary>
        public required HashSet<string> Dropped;
        public readonly List<(JsonObject Problem, string? Cause)> Found = [];
        /// <summary>Execution metadata of the disposable round, including a successful Verify that found no problems.</summary>
        public JsonObject? Execution;
        public JsonArray Normalizations = [];
    }

    private static bool PatchRoundApplies(Exception refusal)
        => (Errors.FindCoded(refusal)?.Problems ?? new JsonArray()).OfType<JsonObject>()
            .Any(p => p["patch"] is JsonArray { Count: > 0 } || OwnerRuleCodes.Contains(p["code"]?.ToString() ?? "")
                // A malformed text without a patch must not hide the Verify of independent texts of the same op.
                // Plan already leaves out texts whose non-Verify problem has no patch, while retaining original indices.
                || p["phase"]?.ToString() != "verify" && Regex.IsMatch(p["pointer"]?.ToString() ?? "", @"/data/flow(?:/\d+)?$"));

    private static Exception PatchRound(Exception refusal, ModelHost host, string basePath, JsonArray ops, Action<string>? log,
        IReadOnlyList<ExpectedMessage> expected, bool expectedValid, bool builtBase, string opsPointer)
    {
        try
        {
            var coded = Errors.FindCoded(refusal);
            if (coded?.Problems is not { } problems) return refusal;
            var listed = problems.OfType<JsonObject>().ToList();
            // The job of the round: every distinct patch of the refusal written in.
            JsonNode document = opsPointer.Length == 0 ? ops.DeepClone() : new JsonObject { ["ops"] = ops.DeepClone() };
            var patches = listed.Select(p => p["patch"]).OfType<JsonArray>().DistinctBy(p => p.ToJsonString()).ToList();
            foreach (var patch in patches)
                if (Patched(document, patch) is { } next) document = next;
                else { log?.Invoke("  patch round: a patch of the refusal does not apply to the job"); return refusal; }
            var applied = (opsPointer.Length == 0 ? document : document["ops"])!.AsArray();
            if (applied.Count != ops.Count) return refusal;
            var probe = Plan(listed, ops, applied, opsPointer);
            if (probe == null) return refusal;
            log?.Invoke($"  patch round: {patches.Count} patch(es), {probe.Changed.Count} op(s) changed, {probe.Dropped.Count} text(s) left out");
            var preflight = JobPreflight.Analyze(applied, document);
            var outPath = Path.Combine(host.WorkDirectory, "patch-round", Guid.NewGuid().ToString("N") + ".oml");
            if (ApplyResolvedCore(host, basePath, applied, outPath, null, expected, expectedValid, preflight, builtBase, opsPointer, null, probe) is not Probe ran) return refusal;
            return Merge(refusal, coded, listed, ran, opsPointer, log);
        }
        catch (Exception ex)
        {
            // The round only adds to a refusal: when it cannot run, the refusal stands as it was.
            log?.Invoke("  patch round did not run: " + Errors.Text(ex));
            return refusal;
        }
    }

    // The round's job: which ops the patches changed, the texts of each logic text op (with the ones no patch fixes left out),
    // and whether the round can learn anything (a patch, or a text of an op that applies without the ones left out).
    private static Probe? Plan(List<JsonObject> problems, JsonArray ops, JsonArray applied, string opsPointer)
    {
        var changed = new HashSet<int>();
        for (var i = 0; i < ops.Count; i++) if (!JsonNode.DeepEquals(ops[i], applied[i])) changed.Add(i);
        var texts = new Dictionary<int, List<(int, bool, string, string?)>>();
        var dropped = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var learns = changed.Count > 0;
        for (var i = 0; i < applied.Count; i++)
        {
            if (applied[i] is not JsonObject op || op["op"]?.ToString() != "logic" || op["data"] is not JsonObject data || !data.ContainsKey("flow")) continue;
            if (ops[i]?["data"] is not JsonObject before) continue;
            var sent = FlowTextForm.Texts(before);
            var now = FlowTextForm.Texts(data);
            var at = opsPointer + "/" + i + "/data";
            // A text whose problems (but the Verify's) include one no patch fixes fails again: it is left out of the round.
            var leave = new HashSet<int>();
            for (var j = 0; j < now.Count && j < sent.Count; j++)
            {
                var pointer = at + sent[j].Pointer;
                if (problems.Any(p => p["pointer"]?.ToString() == pointer && p["phase"]?.ToString() != "verify" && p["patch"] is not JsonArray)) leave.Add(j);
            }
            var entries = now.Select((t, j) => (Original: j < sent.Count ? j : -1, Changed: j >= sent.Count || t.Text != sent[j].Text, Text: t.Text, Before: j < sent.Count ? sent[j].Text : null)).ToList();
            var names = now.Select(t => Name(t.Text)).ToList();
            // What uses an action left out is left out with it.
            for (var grew = true; grew;)
            {
                grew = false;
                foreach (var j in Enumerable.Range(0, now.Count).Where(j => !leave.Contains(j)))
                    if (leave.Any(l => names[l].Length > 0 && Uses(now[j].Text, names[l]))) { leave.Add(j); grew = true; }
            }
            if (leave.Count == 0) { texts[i] = entries; continue; }
            foreach (var j in leave) if (names[j].Length > 0) dropped.Add(names[j]);
            if (leave.Count < now.Count) learns = true;
            var kept = Enumerable.Range(0, now.Count).Where(j => !leave.Contains(j)).ToList();
            var flow = new JsonArray();
            foreach (var j in kept)
                flow.Add(data["flow"] is JsonArray list && (list[j] is JsonObject || now[j].BasedOn == null) ? list[j]!.DeepClone()
                    : now[j].BasedOn is { } based ? new JsonObject { ["text"] = now[j].Text, ["basedOn"] = based } : JsonValue.Create(now[j].Text));
            data.Remove("basedOn");
            data["flow"] = flow;
            texts[i] = kept.Select(j => entries[j]).ToList();
            changed.Add(i);
        }
        return learns ? new Probe { OpsPointer = opsPointer, Original = ops, Applied = applied, Texts = texts, Changed = changed, Dropped = dropped } : null;

        static string Name(string text) => FlowTextForm.Header(text) is { } header
            ? (header.Owner.Length > 0 ? header.Owner + "." : "") + header.Name : "";

        static bool Uses(string text, string name)
        {
            text = Regex.Replace(text, "\"(?:[^\"\\r\\n]|\"\")*\"|(?m)^\\s*///[^\\r\\n]*|(?m)\\s+# [^\\r\\n]*", " ");
            if (Word(name).IsMatch(text)) return true;
            var dot = name.LastIndexOf('.');
            return dot > 0 && FlowTextForm.Header(text)?.Owner.Equals(name[..dot], StringComparison.OrdinalIgnoreCase) == true
                && Word(name[(dot + 1)..]).IsMatch(text);
        }
    }

    private static Regex Word(string name) => new(@"(?<![\p{L}\p{N}_$])" + Regex.Escape(name) + @"(?![\p{L}\p{N}_])", RegexOptions.IgnoreCase);

    // Inside the round, with its model: each problem with the patch that caused it (null: a problem of the job itself).
    private static void Classify(Probe probe, ModelSession session, IEnumerable<JsonObject> problems)
    {
        foreach (var problem in problems)
        {
            if (problem["severity"]?.ToString() == "warning") continue;
            var p = problem.DeepClone().AsObject();
            string? cause = null;
            var op = p["op"] is JsonValue v && v.TryGetValue<int>(out var index) ? index : (int?)null;
            var phase = p["phase"]?.ToString();
            var pointer = p["pointer"]?.ToString();
            var key = p["key"]?.ToString();
            if (op is { } i && probe.Texts.TryGetValue(i, out var texts))
            {
                var at = probe.OpsPointer + "/" + i + "/data/flow";
                int? k = pointer == at ? 0 : pointer != null && pointer.StartsWith(at + "/", StringComparison.Ordinal) && int.TryParse(pointer[(at.Length + 1)..].Split('/')[0], out var n) ? n : null;
                var written = session.FlowTextsWritten.Where(w => w.Op == i).ToList();
                var chain = key != null ? session.KeyChain(key) : [];
                if (k == null && chain.Count > 0 && written.FirstOrDefault(w => chain.Contains(w.ActionKey)) is { } holder)
                    k = holder.Pointer == "/flow" ? 0 : int.TryParse(holder.Pointer[(holder.Pointer.LastIndexOf('/') + 1)..], out var m) ? m : null;
                if (k is { } j && j < texts.Count)
                {
                    var (original, isChanged, text, before) = texts[j];
                    if (isChanged)
                    {
                        if (phase != "verify" || key == null) cause = Short(p);
                        else if (original < 0) cause = Short(p);
                        else
                        {
                            var w = written.FirstOrDefault(x => x.Text == text);
                            var fixedKeys = w == null ? [] : FixedIds(before!, text).Select(id => w.Keys.GetValueOrDefault(id)).OfType<string>().ToHashSet(StringComparer.Ordinal);
                            if (w == null || chain.Any(fixedKeys.Contains)) cause = Short(p);
                        }
                    }
                    // The pointer of the text in the op as sent.
                    if (cause == null && original >= 0)
                    {
                        p["pointer"] = probe.OpsPointer + "/" + i + "/data/flow" + (probe.Original[i]?["data"]?["flow"] is JsonArray ? "/" + original : "");
                        if (p["patch"] is JsonArray patch)
                            p["patch"] = RebaseFlowPatch(patch, probe.OpsPointer + "/" + i + "/data", probe.Original[i]!["data"]!.AsObject(), texts.Select(t => t.Original).ToList());
                    }
                }
                else if (phase != "verify") cause = Short(p);
            }
            else if (op is { } changedOp && probe.Changed.Contains(changedOp) && phase != "verify") cause = Short(p);
            probe.Found.Add((p, cause));
        }
    }

    // Patches found after leaving texts out still target the job as sent. Item edits keep their precise paths; an
    // entire-list/data edit restores the omitted entries and their basedOn metadata around the edited entries.
    internal static JsonArray? RebaseFlowPatch(JsonArray patch, string dataPath, JsonObject originalData, IReadOnlyList<int> indices)
    {
        var result = new JsonArray();
        var flowPath = dataPath + "/flow";
        foreach (var item in patch.OfType<JsonObject>()) {
            var step = item.DeepClone().AsObject();
            foreach (var field in new[] { "path", "from" }) {
                if (step[field]?.ToString() is not { } path || !path.StartsWith(flowPath + "/", StringComparison.Ordinal)) continue;
                var tail = path[(flowPath.Length + 1)..];
                var slash = tail.IndexOf('/');
                if (!int.TryParse(slash < 0 ? tail : tail[..slash], out var index) || index < 0 || index >= indices.Count || indices[index] < 0) return null;
                var suffix = slash < 0 ? "" : tail[slash..];
                var original = indices[index];
                var old = originalData["flow"] is JsonArray originalList ? originalList[original] : originalData["flow"];
                if (suffix == "/text" && old is JsonValue) suffix = "";
                if (field == "path" && suffix == "/basedOn" && old is JsonValue) {
                    if (originalData["flow"] is not JsonArray) { step[field] = dataPath + "/basedOn"; continue; }
                    if (step["op"]?.ToString() is not ("replace" or "add")) return null;
                    step["op"] = "replace";
                    step["value"] = new JsonObject { ["text"] = old.DeepClone(), ["basedOn"] = step["value"]?.DeepClone() };
                    suffix = "";
                }
                step[field] = flowPath + (originalData["flow"] is JsonArray ? "/" + original : "") + suffix;
            }
            var at = step["path"]?.ToString();
            if (at == flowPath && step["value"] is JsonArray list) {
                if (Restore(list) is not { } restored) return null;
                if (originalData["flow"] is JsonArray) step["value"] = restored;
                else {
                    var restoredData = originalData.DeepClone().AsObject();
                    SetFlow(restoredData, restored);
                    step["path"] = dataPath; step["value"] = restoredData;
                }
            }
            else if (at == dataPath && step["value"] is JsonObject replacementData && replacementData["flow"] != null) {
                var items = replacementData["flow"] is JsonArray array ? array : new JsonArray(replacementData["flow"]!.DeepClone());
                if (Restore(items) is not { } restored) return null;
                SetFlow(replacementData, restored);
            }
            result.Add(step);
        }
        return result;

        JsonArray? Restore(JsonArray compacted)
        {
            if (compacted.Count < indices.Count || indices.Any(i => i < 0)) return null;
            var restored = originalData["flow"] is JsonArray all ? all.DeepClone().AsArray() : new JsonArray(originalData["flow"]!.DeepClone());
            for (var i = 0; i < indices.Count; i++) restored[indices[i]] = compacted[i]?.DeepClone();
            for (var i = indices.Count; i < compacted.Count; i++) restored.Add(compacted[i]?.DeepClone());
            return restored;
        }

        void SetFlow(JsonObject data, JsonArray restored)
        {
            if (originalData["flow"] is not JsonArray && restored.Count == 1) {
                if (restored[0] is JsonObject text) {
                    data["flow"] = text["text"]?.DeepClone();
                    if (text["basedOn"] is { } basis) data["basedOn"] = basis.DeepClone(); else data.Remove("basedOn");
                }
                else data["flow"] = restored[0]?.DeepClone();
            }
            else {
                if (originalData["basedOn"] is { } shared) {
                    var originalCount = originalData["flow"] is JsonArray originalList ? originalList.Count : 1;
                    for (var i = 0; i < originalCount; i++) if (restored[i] is JsonValue text)
                        restored[i] = new JsonObject { ["text"] = text.DeepClone(), ["basedOn"] = shared.DeepClone() };
                }
                data.Remove("basedOn");
                data["flow"] = restored;
            }
        }
    }

    // The ids of the nodes on the lines of the corrected text that the text as sent does not have (a longest common
    // subsequence of the lines): the nodes a fix wrote.
    private static HashSet<string> FixedIds(string before, string after)
    {
        var a = before.Replace("\r\n", "\n").Split('\n'); var b = after.Replace("\r\n", "\n").Split('\n');
        var lcs = new int[a.Length + 1, b.Length + 1];
        for (var x = a.Length - 1; x >= 0; x--)
            for (var y = b.Length - 1; y >= 0; y--)
                lcs[x, y] = a[x] == b[y] ? lcs[x + 1, y + 1] + 1 : Math.Max(lcs[x + 1, y], lcs[x, y + 1]);
        var added = new HashSet<int>();
        for (int x = 0, y = 0; y < b.Length;)
        {
            if (x < a.Length && a[x] == b[y]) { x++; y++; }
            else if (x < a.Length && lcs[x + 1, y] >= lcs[x, y + 1]) x++;
            else { added.Add(y + 1); y++; }
        }
        var ids = new HashSet<string>(StringComparer.Ordinal);
        Dictionary<string, int> lines;
        try { lines = Anvil.Reading.FlowParser.NodeLines(after); } catch (FormatException) { return ids; }
        // A changed line belongs to the node whose line is the nearest one at or above it.
        var starts = lines.OrderBy(l => l.Value).ToList();
        foreach (var line in added)
            if (starts.LastOrDefault(s => s.Value <= line) is { Key: { } id }) ids.Add(id);
        return ids;
    }

    private static string Short(JsonObject p)
    {
        var message = Regex.Replace(p["message"]?.ToString() ?? "", @"\s+", " ");
        return p["code"] + ": " + (message.Length > 160 ? message[..160] + "…" : message);
    }

    // The refusal with what the round found: the problems of the job it could not see, and no patch where a patch caused one.
    private static Exception Merge(Exception refusal, ICodedError coded, List<JsonObject> listed, Probe probe, string opsPointer, Action<string>? log)
    {
        var said = listed.Select(Signature).ToHashSet(StringComparer.Ordinal);
        var broken = new Dictionary<int, string>();
        var added = new List<JsonObject>();
        foreach (var (p, cause) in probe.Found)
        {
            var op = p["op"] is JsonValue v && v.TryGetValue<int>(out var i) ? i : (int?)null;
            // What the refusal already says (a problem no patch fixes, found again), and what only leaving a text out made
            // fail, is not news, nor the patch's fault.
            if (said.Contains(Signature(p)) || probe.Dropped.Any(name => Word(name).IsMatch(p["message"]?.ToString() ?? ""))) continue;
            if (cause != null)
            {
                if (op is { } o) broken.TryAdd(o, cause);
                continue;
            }
            if (!said.Add(Signature(p))) continue;
            p["afterPatch"] = true;
            p.Remove("_generic");
            added.Add(p);
        }
        var problems = coded.Problems!;
        foreach (var (op, cause) in broken)
        {
            var at = opsPointer + "/" + op;
            foreach (var p in problems.OfType<JsonObject>())
                if (p["patch"] is JsonArray patch && patch.OfType<JsonObject>().Any(s => s["path"]?.ToString() is { } path && (path == at || path.StartsWith(at + "/", StringComparison.Ordinal))))
                {
                    p["patch"] = null;
                    p["fix"] = p["fix"] + " (no patch: applied to the job, the corrected op was refused: " + cause + ")";
                }
            log?.Invoke($"  patch round: the patch of op #{op} is not offered ({cause})");
        }
        foreach (var p in added) problems.Add(JobPreflight.PublicProblem(p));
        if (added.Count > 0) log?.Invoke($"  patch round: {added.Count} problem(s) the refusal could not see");
        var priorPhases = refusal is JobPreflightException pf ? pf.Phases ?? []
            : (Errors.Diagnosis(refusal)?["phases"] as JsonArray ?? new JsonArray()).Select(p => p?.ToString()).OfType<string>().ToList();
        var roundPhases = (probe.Execution?["phases"] as JsonArray ?? new JsonArray()).Select(p => p?.ToString()).OfType<string>();
        var observedPhases = priorPhases.Concat(roundPhases).Concat(problems.OfType<JsonObject>().Select(p => p["phase"]?.ToString()).OfType<string>()).ToHashSet(StringComparer.Ordinal);
        var phases = new[] { "preflight", "base", "apply", "verify" }.Where(observedPhases.Contains).ToList();
        var originalExecution = Errors.Diagnosis(refusal);
        var verifyRan = originalExecution?["verifyRan"]?.GetValue<bool>() == true || probe.Execution?["verifyRan"]?.GetValue<bool>() == true;
        var verifyReason = verifyRan ? null : originalExecution?["verifyReason"]?.ToString() ?? probe.Execution?["verifyReason"]?.ToString();
        Errors.Annotate(refusal, verifyRan, verifyReason, phases, problems);
        var normalizations = Errors.Normalizations(refusal) ?? new JsonArray();
        foreach (var note in ProbeNormalizations(probe))
            if (!normalizations.OfType<JsonObject>().Any(existing => Preflight.JobNormalizer.Same(existing, note)))
            {
                note["afterPatch"] = true;
                normalizations.Add(note);
            }
        if (normalizations.Count > 0) refusal.Data[Errors.NormalizationsKey] = normalizations.DeepClone();
        if (broken.Count == 0 && added.Count == 0) return refusal;
        if (refusal is JobPreflightException preflight)
        {
            var lines = new List<string> { preflight.Message };
            lines.AddRange(added.Select(JobPreflight.Text));
            var merged = new JobPreflightException(string.Join(Environment.NewLine, lines), problems, preflight.Warnings, preflight.InnerException)
                { VerifyRan = verifyRan, VerifyReason = verifyReason, Phases = phases };
            // The normalizations of the job (lentidao 2026-10-12) stay with the refusal the round rewrote.
            Errors.AttachNormalizations(merged, normalizations);
            return merged;
        }
        if (Errors.Diagnosis(refusal) is { } diagnosis)
            Errors.Annotate(refusal, diagnosis["verifyRan"]?.GetValue<bool>() ?? true, diagnosis["verifyReason"]?.ToString(), phases, problems);
        return refusal;

        // One problem by what it says: its code, its op and its message without the place inside a text. Native child
        // enumeration order can change when the disposable module is loaded again; that order is advice, not a new fault.
        static string Signature(JsonObject p)
        {
            var message = p["message"]?.ToString() ?? "";
            if (p["code"]?.ToString() == "CHILD_NOT_FOUND")
                message = Regex.Replace(message, @"\(children: (?<children>[^)]*)\)", m => "(children: "
                    + string.Join(", ", m.Groups["children"].Value.Split(',').Select(child => child.Trim())
                        .Distinct(StringComparer.Ordinal).OrderBy(child => child, StringComparer.Ordinal)) + ")");
            return p["code"] + "|" + p["op"]?.ToJsonString() + "|"
                + Regex.Replace(Regex.Replace(message, @"^(logic: |html: line \d+ col \d+: )", ""), @"\s+", " ").Trim();
        }
    }

    // The round can omit texts that no patch fixes. Its normalization paths use those compacted indices; the refusal's
    // paths always refer to the sent job, just like Classify maps the round's problems above.
    private static IEnumerable<JsonObject> ProbeNormalizations(Probe probe)
    {
        foreach (var item in probe.Normalizations.OfType<JsonObject>())
        {
            var note = item.DeepClone().AsObject();
            if (note["path"]?.ToString() is { } path && probe.Texts != null)
                foreach (var (op, texts) in probe.Texts)
                {
                    var prefix = probe.OpsPointer + "/" + op + "/data/flow";
                    if (!path.StartsWith(prefix + "/", StringComparison.Ordinal)) continue;
                    var tail = path[(prefix.Length + 1)..];
                    var slash = tail.IndexOf('/');
                    if (!int.TryParse(slash < 0 ? tail : tail[..slash], out var index) || index < 0 || index >= texts.Count) break;
                    var original = texts[index].Original;
                    if (original < 0) break; // an action inserted by the patch keeps its patch-source path
                    var suffix = slash < 0 ? "" : tail[slash..];
                    note["path"] = prefix + (probe.Original[op]?["data"]?["flow"] is JsonArray ? "/" + original : "") + suffix;
                    break;
                }
            yield return note;
        }
    }

    // The job with one patch (RFC 6902: add, remove, replace, test) written in; null when a step does not apply.
    private static JsonNode? Patched(JsonNode document, JsonArray patch)
    {
        var doc = document.DeepClone();
        foreach (var step in patch.OfType<JsonObject>())
        {
            var path = step["path"]?.ToString() ?? "";
            var tokens = path.Length == 0 ? [] : path.Split('/').Skip(1).Select(t => t.Replace("~1", "/").Replace("~0", "~")).ToList();
            var verb = step["op"]?.ToString();
            if (tokens.Count == 0)
            {
                if (verb is "replace" or "add") doc = step["value"]!.DeepClone(); else return null;
                continue;
            }
            JsonNode? parent = doc;
            foreach (var token in tokens.Take(tokens.Count - 1))
                parent = parent switch { JsonObject o => o[token], JsonArray a when int.TryParse(token, out var n) && n < a.Count => a[n], _ => null };
            var last = tokens[^1];
            switch (verb, parent)
            {
                case ("test", _):
                    var current = parent switch { JsonObject o => o[last], JsonArray a when int.TryParse(last, out var n) && n < a.Count => a[n], _ => null };
                    if (!JsonNode.DeepEquals(current, step["value"])) return null;
                    break;
                case ("replace" or "add", JsonObject o): o[last] = step["value"]?.DeepClone(); break;
                case ("replace", JsonArray a) when int.TryParse(last, out var n) && n < a.Count: a[n] = step["value"]?.DeepClone(); break;
                case ("add", JsonArray a) when last == "-": a.Add(step["value"]?.DeepClone()); break;
                case ("add", JsonArray a) when int.TryParse(last, out var n) && n <= a.Count: a.Insert(n, step["value"]?.DeepClone()); break;
                case ("remove", JsonObject o) when o.ContainsKey(last): o.Remove(last); break;
                case ("remove", JsonArray a) when int.TryParse(last, out var n) && n < a.Count: a.RemoveAt(n); break;
                default: return null;
            }
        }
        return doc;
    }
}
