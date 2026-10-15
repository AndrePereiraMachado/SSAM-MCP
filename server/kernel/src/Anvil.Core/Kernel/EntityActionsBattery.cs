using System.Text.Json.Nodes;
using Anvil.Reading;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// The proof of the op entity-actions on a real module (EntityActionsCorpusTests, the CLI `entity-actions-battery`): the module is
/// loaded from its bytes (a copy in memory, nothing saved), the op runs over every server entity, and the report says whether
/// the apply was refused (the owner's rules, QUERY_IN_LOOP and the compile check run inside it), which Verify errors are new,
/// which created actions do not read back as a fixed point of their text, and whether the same op again is NO_CHANGE.
/// </summary>
public static class EntityActionsBattery
{
    /// <summary>The op over one module loaded from its bytes: the report of the checks. ddl: a data text applied first (the
    /// data model of a module built from a blank one), in its own apply.</summary>
    public static JsonObject Run(ModelHost host, byte[] oml, string label, JsonObject data, string? ddl = null)
    {
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var espace = host.Load(oml);
        var failures = new JsonArray();
        var report = new JsonObject { ["label"] = label, ["failures"] = failures };
        try
        {
            if (ddl != null)
            {
                try { new ModelSession(espace).Apply(new JsonArray(new JsonObject { ["op"] = "spec", ["data"] = new JsonObject { ["ddl"] = ddl } })); }
                catch (Exception error)
                {
                    failures.Add("the data text of the setup was refused: " + Errors.Text(error));
                    report["entities"] = 0; report["created"] = 0; report["bytes"] = 0; report["newErrors"] = new JsonArray(); report["readBackDifferent"] = new JsonArray();
                    return report;
                }
            }
            var before = ModelHost.Messages(espace).Where(m => m.IsError).Select(m => m.Id + " " + m.Path).ToList();
            JsonObject result;
            try
            {
                var op = System.Diagnostics.Stopwatch.StartNew();
                var answer = new ModelSession(espace).Apply(new JsonArray(new JsonObject { ["op"] = "entity-actions", ["data"] = data.DeepClone() }));
                report["opMs"] = op.ElapsedMilliseconds;
                result = answer.OfType<JsonObject>().First(r => r["op"]?.ToString() == "entity-actions")["result"]!.AsObject();
            }
            catch (Exception error)
            {
                failures.Add("refused: " + Errors.Text(error));
                if (Errors.FindCoded(error) is KernelRefusalException coded && coded.Problems != null) report["problems"] = coded.Problems.DeepClone();
                report["entities"] = 0; report["created"] = 0; report["bytes"] = 0; report["newErrors"] = new JsonArray(); report["readBackDifferent"] = new JsonArray();
                return report;
            }
            var actions = result["entityActions"]!.AsObject();
            report["result"] = actions.DeepClone();
            var createdList = actions["created"]!.AsArray();
            report["entities"] = actions["entities"]!.AsArray().Count;
            report["created"] = createdList.Count;
            // The Verify: no error the module did not have.
            var left = before.GroupBy(e => e).ToDictionary(g => g.Key, g => g.Count());
            var added = new JsonArray();
            foreach (var message in ModelHost.Messages(espace).Where(m => m.IsError))
            {
                var key = message.Id + " " + message.Path;
                if (left.TryGetValue(key, out var n) && n > 0) { left[key] = n - 1; continue; }
                added.Add(message.ToString());
            }
            report["newErrors"] = added;
            foreach (var error in added.Take(20)) failures.Add("Verify: " + error);
            // The read back: each created action is a fixed point of its text.
            var reader = new KernelModelReader();
            var root = (IObjectSignature)espace;
            var different = new JsonArray();
            var bytes = 0;
            var texts = new JsonObject();
            var padroes = new JsonArray();
            foreach (var item in createdList.OfType<JsonObject>())
            {
                var key = item["key"]?.ToString();
                var action = key == null ? null : reader.ChildrenOf(root).FirstOrDefault(c => c.ObjectKey?.ToString() == key);
                if (action == null) { different.Add(item["name"]!.ToString() + ": not in the module"); continue; }
                var read = ModuleFlow.Extract(root, reader, action, out var problems);
                var document = ModuleFlow.Print(read);
                foreach (var finding in Padroes(read)) padroes.Add(item["name"] + ": " + finding);
                bytes += System.Text.Encoding.UTF8.GetByteCount(document.Text);
                texts[item["name"]!.ToString()] = document.Text;
                if (problems.Count > 0 || document.Unprintable.Count > 0 || ModuleFlow.Check(read, document) is { } why)
                    different.Add(item["name"] + ": not a fixed point (" + string.Join("; ", problems.Concat(document.Unprintable).Take(3)) + ")");
            }
            report["bytes"] = bytes;
            // The compile check (CompileCheck.cs: what the OutSystems compiler cannot build) over every element the op
            // created: the generated actions, their nodes and parameters, and the row structures; a plain apply outside a
            // delivery does not run it, so the battery does.
            var createdKeys = createdList.OfType<JsonObject>().Select(c => c["key"]?.ToString()).OfType<string>().ToHashSet(StringComparer.Ordinal);
            var structures = (actions["structures"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().Where(x => x["created"]?.GetValue<bool>() == true).Select(x => x["name"]!.ToString()).ToHashSet(StringComparer.OrdinalIgnoreCase);
            var mine = new List<IObjectSignature>();
            foreach (var element in reader.ChildrenOf(root))
                if (createdKeys.Contains(element.ObjectKey?.ToString() ?? "") || structures.Contains(reader.NameOf(element)) && reader.KindOf(element) == "Structure")
                    mine.AddRange(reader.Walk(element));
            var compile = CompileCheck.Run(root, mine).Where(f => !f.Warning).Select(f => f.Code + " " + f.Path + ": " + f.Message).ToList();
            report["compileFindings"] = new JsonArray(compile.Select(f => (JsonNode)f).ToArray());
            report["compileChecked"] = mine.Count;
            foreach (var finding in compile.Take(20)) failures.Add("compile check: " + finding);
            report["readBackDifferent"] = different;
            report["padroes"] = padroes;
            foreach (var finding in padroes.Take(20)) failures.Add("padrões: " + finding);
            foreach (var d in different) failures.Add("read back: " + d);
            if (Environment.GetEnvironmentVariable("ENTITY_ACTIONS_TEXTS") == "1") report["texts"] = texts;
            // The same op again: nothing to do.
            try
            {
                var again = new ModelSession(espace).Apply(new JsonArray(new JsonObject { ["op"] = "entity-actions", ["data"] = data.DeepClone() }));
                var second = again.OfType<JsonObject>().First(r => r["op"]?.ToString() == "entity-actions")["result"]!.AsObject();
                report["secondNoChange"] = second["noChange"]?.GetValue<bool>() == true;
                report["secondUnchanged"] = second["entityActions"]?["unchanged"]?.AsArray().Count;
                if (second["entityActions"]?["kept"] is JsonArray secondKept && secondKept.Count > 0) report["secondKept"] = secondKept.DeepClone();
                if (second["noChange"]?.GetValue<bool>() != true)
                    failures.Add("second run is not NO_CHANGE: created " + second["entityActions"]?["created"]?.AsArray().Count + ", kept " + second["entityActions"]?["kept"]?.ToJsonString());
                var keptFirst = actions["kept"]?.AsArray().Count ?? 0;
                if ((second["entityActions"]?["kept"]?.AsArray().Count ?? 0) != keptFirst)
                    failures.Add("second run keeps " + (second["entityActions"]?["kept"]?.AsArray().Count ?? 0) + " actions, the first kept " + keptFirst);
            }
            catch (Exception error) { failures.Add("second run refused: " + Errors.Text(error)); }
        }
        finally { ModelHost.Release(espace); }
        report["ms"] = clock.ElapsedMilliseconds;
        return report;
    }

    // ---- the OutSystems padrões stage on what the op wrote (kernel/scripts/outsystems_padroes: its oml stage, rules N1, N2
    // and D2, on the elements a generated action holds): the action starts with a verb, a Boolean is Is/Has/Can, the action,
    // its parameters and its aggregates are described (N2: at least 15 characters, not the name, not only the name's words,
    // no marker), an If is a question, an Assign says its intent, an aggregate has Max Records.
    private static readonly HashSet<string> Verbs = new(StringComparer.Ordinal)
    {
        "Get", "Set", "Create", "Update", "Delete", "Save", "Validate", "Check", "Compute", "Calculate", "Build", "Load", "Fetch", "Send", "Start", "Stop",
        "Cancel", "Approve", "Reject", "Submit", "Record", "Register", "Resolve", "Apply", "Clear", "Reset", "Add", "Remove", "Append", "Find", "Search",
        "List", "Count", "Compare", "Export", "Import", "Parse", "Serialize", "Format", "Invoke", "Dispatch", "Run", "Claim", "Release", "Drain", "Grant",
        "Revoke", "Open", "Close", "Answer", "Ask", "Publish", "Retire", "Verify", "Hash", "Redact", "Reveal", "Notify", "Log", "Audit", "Ensure", "Require",
        "Refresh", "Upload", "Download", "Prepare", "Propose", "Raise", "Handle", "Map", "Convert", "Merge", "Split", "Select", "Filter", "Sort", "Toggle",
        "Show", "Hide", "Navigate", "Initialize", "Accept", "Decline", "Assign", "Complete", "Finish", "Wake", "Schedule", "Clone", "Copy", "Read", "Write",
        "Mark", "Lock", "Unlock", "Enable", "Disable", "Test", "Probe", "Seed", "Generate", "Render", "Describe", "Summarize", "Evaluate", "Score", "Queue",
        "Enqueue", "Dequeue", "Retry", "Resume", "Pause", "Kill", "Deny", "Confirm", "Edit", "Change", "Move", "Rename", "Attach", "Detach", "Link", "Unlink",
        "Sync", "Process", "Execute", "Call", "Emit", "Trigger", "Track", "Store", "Restore", "Purge", "Archive", "Fill", "Go", "Do", "Is", "Has", "Can", "Try",
        "Collect", "Extract", "Snapshot", "Diff", "Replay", "Expire", "Escalate", "Reassign", "Request", "Return", "Receive", "Post", "Put", "Patch", "Sign",
        "Login", "Logout", "Classify", "Measure", "Decide", "Accumulate", "Encode", "Decode", "Route", "Drop", "Report", "Use", "Detect", "Match", "Translate",
        "Normalize", "Sanitize", "Truncate", "Increment", "Decrement", "Bump", "Tag", "Flag", "Stamp", "Pick", "Choose", "Advance", "Upsert", "Stage",
        "Acknowledge", "Reconfirm", "Reconcile",
    };
    private static readonly System.Text.RegularExpressions.Regex CamelTokens = new(@"[A-Z]+(?=[A-Z][a-z]|\d|_|\b|$)|[A-Z]?[a-z]+|\d+", System.Text.RegularExpressions.RegexOptions.Compiled);
    private static readonly System.Text.RegularExpressions.Regex GenericLabel = new(@"^(If|Assign|ForEach|While|Switch|Return)\d*$", System.Text.RegularExpressions.RegexOptions.Compiled);
    private static readonly HashSet<string> StopWords = new(StringComparer.Ordinal) { "the", "a", "an", "of", "to", "for", "and", "or", "in", "on", "by", "with", "o", "os", "as", "de", "da", "do", "das", "dos", "e", "em", "para", "por", "com", "um", "uma", "no", "na" };
    private static readonly HashSet<string> IgnoredNames = new(StringComparer.Ordinal) { "Id", "Label", "Order", "Is_Active" };

    internal static List<string> Padroes(FlowItem action)
    {
        var found = new List<string>();
        void Description(string what, string name, string? text)
        {
            var d = (text ?? "").Trim();
            if (d.Length == 0) { found.Add($"N1 {what} {name} has no description"); return; }
            if (d.Length < 15) found.Add($"N2 {what} {name}: description shorter than 15 characters");
            if (string.Equals(d.TrimEnd('.'), name, StringComparison.OrdinalIgnoreCase)) found.Add($"N2 {what} {name}: description equals the name");
            else
            {
                var words = System.Text.RegularExpressions.Regex.Matches(d, "[A-Za-z0-9]+").Select(m => m.Value.ToLowerInvariant()).Where(w => !StopWords.Contains(w)).ToHashSet();
                var nameWords = CamelTokens.Matches(name).Select(m => m.Value.ToLowerInvariant()).ToHashSet();
                if (words.Count > 0 && nameWords.Count > 0 && words.IsSubsetOf(nameWords)) found.Add($"N2 {what} {name}: description only repeats the name");
            }
            foreach (var marker in new[] { "anvil:html script", "anvil:ui", "STUB DE CONTRATO", "TODO" })
                if (d.Contains(marker, StringComparison.OrdinalIgnoreCase)) found.Add($"N2 {what} {name}: description has the marker {marker}");
        }
        var first = CamelTokens.Matches(action.Name).Select(m => m.Value).FirstOrDefault();
        if (first == null || !Verbs.Contains(first)) found.Add("N1 action " + action.Name + " does not start with a verb");
        Description(action.Kind, action.Name, action.Prop("Description"));
        foreach (var p in action.Items.Where(i => i.Role is "in" or "out" or "local"))
        {
            if (!IgnoredNames.Contains(p.Name) || p.Prop("Description") != null) Description(p.Role, p.Name, p.Prop("Description"));
            if (p.Prop("DataType") == "Boolean" && !System.Text.RegularExpressions.Regex.IsMatch(p.Name, "^(Is|Has|Can)[A-Z0-9]")) found.Add("N1 Boolean " + p.Name + " has no Is/Has/Can prefix");
        }
        foreach (var n in action.Items.Where(i => i.Role == "node"))
        {
            var label = n.Prop("Label") ?? "";
            switch (n.Kind)
            {
                case "AggregateNode":
                    Description("aggregate", n.Name, n.Prop("Description"));
                    if (string.IsNullOrWhiteSpace(n.Prop("MaxRecords"))) found.Add("D2 aggregate " + n.Name + " has no Max Records");
                    break;
                case "IfNode":
                    if (!label.Trim().EndsWith('?') || GenericLabel.IsMatch(label)) found.Add("N1 If '" + label + "' is not a question");
                    break;
                case "AssignNode":
                    if (label.Length == 0 || GenericLabel.IsMatch(label)) found.Add("N1 Assign with the generic label '" + label + "'");
                    break;
            }
        }
        return found;
    }
}
