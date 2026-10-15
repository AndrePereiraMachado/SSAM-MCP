using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;
using OutSystems.Model;
using ESpace = ServiceStudio.Model.ESpace;

namespace Anvil.Core;

/// <summary>
/// The battery of the three-way merge of the logic text (FlowMerge): on real actions, a Studio edit and a model edit of the
/// same read. The Studio edit is written first (the action now differs from the read); the model's text, written on the read
/// (basedOn = its textSha, the read kept in memory as the store keeps it), goes through the logic op and is merged; the action
/// is read again.
/// <list type="bullet">
/// <item>Disjoint (the two edits touch no element in common, by key: FlowEdits kinds on parts the other does not touch): the
/// action must read back as the Studio's action with every element the model touched as the model wrote it (the model's
/// new elements with the keys their creates gave), and no conflict listed.</item>
/// <item>Overlapping: the same expression changed on both sides (same-value), a node the model removes that the Studio changed
/// (removed-changed), a node the Studio removes that the model changed (changed-removed: written again with a new key), a
/// step inserted by both after the same node (both-insert: both kept, the model's first). The conflict must be listed with
/// the element's key, the delivery's side kept, and every other element as the Studio left it.</item>
/// </list>
/// Exact means the action read back, as its canonical model (every key, property, part and connector), is the expected one.
/// After each case the action is put back to its read (as FlowBattery undoes), so the next case starts from a read again.
/// </summary>
public static class FlowMergeBattery
{
    public sealed class Tally
    {
        public int Actions, Skipped, Cases, Exact, Disjoint, DisjointExact, Overlap, OverlapExact, Conflicts, Reloads, Verified, VerifyRefused;
        public readonly SortedDictionary<string, int> ByCase = new(StringComparer.Ordinal);
        public readonly SortedDictionary<string, int> ExactByCase = new(StringComparer.Ordinal);
        public readonly List<string> Failures = [];
        public double Ms;
        public JsonObject ToJson() => new() {
            ["actions"] = Actions, ["skipped"] = Skipped, ["cases"] = Cases, ["exact"] = Exact,
            ["disjoint"] = Disjoint, ["disjointExact"] = DisjointExact, ["overlap"] = Overlap, ["overlapExact"] = OverlapExact,
            ["conflictsListed"] = Conflicts, ["reloads"] = Reloads, ["verified"] = Verified, ["verifyRefused"] = VerifyRefused, ["ms"] = Math.Round(Ms),
            ["byCase"] = new JsonObject(ByCase.Select(p => KeyValuePair.Create(p.Key, (JsonNode?)p.Value))),
            ["exactByCase"] = new JsonObject(ExactByCase.Select(p => KeyValuePair.Create(p.Key, (JsonNode?)p.Value))),
            ["failures"] = new JsonArray(Failures.Take(40).Select(f => (JsonNode)f).ToArray()) };
        public void Add(Tally other)
        {
            Actions += other.Actions; Skipped += other.Skipped; Cases += other.Cases; Exact += other.Exact; Disjoint += other.Disjoint; DisjointExact += other.DisjointExact;
            Overlap += other.Overlap; OverlapExact += other.OverlapExact; Conflicts += other.Conflicts; Reloads += other.Reloads; Ms += other.Ms;
            Verified += other.Verified; VerifyRefused += other.VerifyRefused;
            foreach (var (k, v) in other.ByCase) ByCase[k] = ByCase.GetValueOrDefault(k) + v;
            foreach (var (k, v) in other.ExactByCase) ExactByCase[k] = ExactByCase.GetValueOrDefault(k) + v;
            Failures.AddRange(other.Failures);
        }
    }

    // The disjoint pairs tried on each action (Studio edit, model edit), in order, until `disjoint` of them are found.
    private static readonly (string Studio, string Model)[] Pairs = [
        ("expression", "expression"), ("call", "expression"), ("expression", "call"), ("remove", "expression"), ("expression", "remove"),
        ("branch", "expression"), ("expression", "branch"), ("call", "call"), ("rename", "expression"), ("expression", "rename"), ("swap", "expression"),
        ("call", "remove"), ("remove", "call")];
    public static readonly string[] OverlapCases = ["same-value", "removed-changed", "changed-removed", "both-insert"];
    // Edits of two different parts of one node (two assignments, arguments, filters or cases), an assignment the Studio adds
    // beside one the model changes, and two lines of one text of code: disjoint, both stay; the same line of code changed on
    // both sides: listed, the delivery's line (review of the junction feat/texto-ssam-2: the parts of a node merge one by one).
    public static readonly string[] SameNodeCases = ["part|part", "insert|part", "code|code", "code-same-line"];

    private static readonly Regex NewId = new(@" @(new[0-9]+|\+[0-9]+)$", RegexOptions.Multiline | RegexOptions.CultureInvariant);

    // Expect: the action as it must read, from the Studio's (read back): the model's change made on it (cases of one node).
    private sealed record Case(string Name, bool Disjoint, FlowItem Studio, FlowItem Model, string? Key = null, Func<FlowItem, FlowItem?>? Expect = null);

    /// <summary>The battery over one module: one action in every `every`, `disjoint` disjoint pairs and every overlapping case each.
    /// only: the actions whose name contains it (else FLOW_MERGE_ONLY, else every one).</summary>
    public static Tally Run(ModelHost host, byte[] oml, string label, string lane, int seed = 1, int every = 1, int disjoint = 2, Action<string>? log = null, string? only = null)
    {
        only ??= Environment.GetEnvironmentVariable("FLOW_MERGE_ONLY") is { Length: > 0 } named ? named : null;
        var tally = new Tally();
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var reader = new KernelModelReader();
        ESpace? espace = null;
        ModelSession session = null!;
        IObjectSignature root = null!;
        Dictionary<string, IObjectSignature> byKey = null!;
        var readings = new Dictionary<string, FlowReading>(StringComparer.Ordinal);
        // One case in every FLOW_BATTERY_VERIFY is exact only without a new Verify error under its action (BatteryVerify).
        var verify = new BatteryVerify();
        void Load()
        {
            if (espace != null) ModelHost.Release(espace);
            espace = host.Load(oml);
            verify.Module = espace;
            session = new ModelSession(espace) { FlowReadings = sha => readings.GetValueOrDefault(sha) };
            root = (IObjectSignature)espace;
            byKey = reader.Walk(root).Where(n => ModuleFlow.ActionKinds.Contains(reader.KindOf(n)) && !UnderReference(reader, n, root))
                .ToDictionary(reader.KeyOf, StringComparer.Ordinal);
        }
        try {
            Load();
            var keys = byKey.Keys.Order(StringComparer.Ordinal).ToList();
            var calls = new Dictionary<bool, List<FlowItem>> { [true] = [], [false] = [] };
            foreach (var key in keys) {
                var item = ModuleFlow.Extract(root, reader, byKey[key], out _);
                if (item.Kind is not ("ServerAction" or "ServiceAction" or "ClientAction")) continue;
                foreach (var call in item.Items.Where(i => i.Role == "node" && i.Kind == "Execute" && !i.Opaque).Take(2)) calls[item.Kind == "ClientAction"].Add(call);
            }
            var index = 0;
            foreach (var key in keys) {
                if (index++ % every != 0) continue;
                if (only != null && !reader.DisplayOf(byKey[key]).Contains(only, StringComparison.Ordinal)) continue;
                if (index % 50 == 0) log?.Invoke(label + ": " + index + "/" + keys.Count + " actions, " + tally.Cases + " cases, " + clock.Elapsed.TotalSeconds.ToString("0") + " s");
                var first = ModuleFlow.Extract(root, reader, byKey[key], out var problems);
                var firstRead = ModuleFlow.Print(first);
                if (problems.Count > 0 || firstRead.Unprintable.Count > 0) { tally.Skipped++; continue; }
                tally.Actions++;
                var name = label + " " + reader.DisplayOf(byKey[key]);
                foreach (var made in Cases(first, key, seed, disjoint, calls)) {
                    var action = byKey[key];
                    var @base = ModuleFlow.Extract(root, reader, action, out var baseProblems);
                    var read = ModuleFlow.Print(@base);
                    if (baseProblems.Count > 0 || read.Unprintable.Count > 0 || @base.Canon() != first.Canon() && !SameShape(@base, first)) break;
                    // The case was made on the first read: made again on this read when the keys moved (an undone removal).
                    var study = @base.Canon() == first.Canon() ? made : Remake(made, first, @base, key, seed, calls);
                    if (study == null) continue;
                    var check = verify.Sample();
                    if (check) verify.Before(action);
                    var outcome = RunCase(session, root, reader, action, @base, read, study, readings, lane, bare: FlowBattery.StableSeed(seed, key, study.Name) % 2 == 1);
                    if (outcome.Why == null && check && verify.Added(action) is { Count: > 0 } added)
                        outcome = outcome with { Why = "reads back as expected, and the Verify has new errors under the action: " + string.Join("; ", added.Take(3)) };
                    tally.Cases++;
                    tally.ByCase[study.Name] = tally.ByCase.GetValueOrDefault(study.Name) + 1;
                    if (study.Disjoint) tally.Disjoint++; else tally.Overlap++;
                    tally.Conflicts += outcome.Conflicts;
                    if (outcome.Why == null) {
                        tally.Exact++; tally.ExactByCase[study.Name] = tally.ExactByCase.GetValueOrDefault(study.Name) + 1;
                        if (study.Disjoint) tally.DisjointExact++; else tally.OverlapExact++;
                    } else {
                        tally.Failures.Add(name + " [" + study.Name + "] " + outcome.Why);
                        log?.Invoke("FAIL " + tally.Failures[^1]);
                    }
                    // Back to the read: the text of the read over the action as it is now.
                    if (!Undo(session, root, reader, action, @base)) { tally.Reloads++; Load(); break; }
                }
            }
        } finally { if (espace != null) ModelHost.Release(espace); }
        tally.Verified = verify.Verified; tally.VerifyRefused = verify.Refused;
        tally.Ms = clock.Elapsed.TotalMilliseconds;
        return tally;
    }

    // Whether two reads of an action are the same but for the keys of nodes made again (an undone removal).
    private static bool SameShape(FlowItem a, FlowItem b) => a.Items.Count == b.Items.Count;

    private static Case? Remake(Case made, FlowItem first, FlowItem now, string key, int seed, Dictionary<bool, List<FlowItem>> calls) =>
        Cases(now, key, seed, 2, calls).FirstOrDefault(c => c.Name == made.Name);

    // ---- the cases -------------------------------------------------------------------------------------------------------------

    private static IEnumerable<Case> Cases(FlowItem read, string key, int seed, int disjoint, Dictionary<bool, List<FlowItem>> calls)
    {
        var found = 0;
        // Each action starts at another pair (by its key), so the kinds spread over the module.
        var start = FlowBattery.StableSeed(seed, key, "pairs") % Pairs.Length;
        foreach (var (studio, model) in Pairs.Skip(start).Concat(Pairs.Take(start))) {
            if (found >= disjoint) break;
            for (var attempt = 0; attempt < 3; attempt++) {
                var s = FlowEdits.Make(read, studio, FlowBattery.StableSeed(seed + attempt, key, "studio:" + studio), calls);
                var m = FlowEdits.Make(read, model, FlowBattery.StableSeed(seed + attempt, key, "model:" + model), calls);
                if (s == null || m == null) break;
                StudioNames(s.Model, read);
                var ts = Touched(read, s.Model); var tm = Touched(read, m.Model);
                // New elements are each side's own (both may call theirs new1): only the read's elements can be shared.
                var readKeys = Elements(read).Keys.ToHashSet(StringComparer.Ordinal);
                if (ts.Count == 0 || tm.Count == 0 || ts.Where(readKeys.Contains).Any(tm.Contains)) continue;
                // A connector one edit writes to a node the other removes is not disjoint either.
                if (GoesTo(m.Model, tm, Removed(read, s.Model)) || GoesTo(s.Model, ts, Removed(read, m.Model))) continue;
                found++;
                yield return new Case(studio + "|" + model, true, s.Model, m.Model);
                break;
            }
        }
        // same-value: one expression, wrapped once in the Studio and twice by the model.
        if (Slot(read, FlowBattery.StableSeed(seed, key, "same-value"), null) is { } slot) {
            var s = read.Clone(); var m = read.Clone();
            Wrap(s, slot, 1); Wrap(m, slot, 2);
            yield return new Case("same-value", false, s, m, slot.Node);
        }
        // removed-changed: the model removes a step the Studio changed; changed-removed: the reverse.
        for (var attempt = 0; attempt < 4; attempt++) {
            var removal = FlowEdits.Make(read, "remove", FlowBattery.StableSeed(seed + attempt, key, "removal"), calls);
            if (removal == null) break;
            var gone = Removed(read, removal.Model).SingleOrDefault();
            if (gone == null || Slot(read, FlowBattery.StableSeed(seed, key, "changed"), gone) is not { } changed) continue;
            var edited = read.Clone(); Wrap(edited, changed, 1);
            yield return new Case("removed-changed", false, edited, removal.Model, gone);
            var edited2 = read.Clone(); Wrap(edited2, changed, 2);
            yield return new Case("changed-removed", false, removal.Model.Clone(), edited2, gone);
            break;
        }
        // both-insert: a call inserted after the same node on both sides.
        var studioCall = FlowEdits.Make(read, "call", FlowBattery.StableSeed(seed, key, "insert"), calls);
        var modelCall = FlowEdits.Make(read, "call", FlowBattery.StableSeed(seed, key, "insert"), calls);
        if (studioCall != null && modelCall != null) {
            StudioNames(studioCall.Model, read);
            var after = read.Items.Where(i => i.Role == "node").FirstOrDefault(n => studioCall.Model.Items.FirstOrDefault(x => x.Key == n.Key)?.Edges.GetValueOrDefault("Target") == "new1");
            yield return new Case("both-insert", false, studioCall.Model, modelCall.Model, after?.Key);
        }
        foreach (var made in SameNode(read, key, seed)) yield return made;
    }

    // Edits of one node by both sides: two of its parts (part|part), an assignment the Studio adds beside the one the model
    // changes (insert|part), two lines of its code (code|code), the same line of its code (code-same-line, overlapping).
    private static IEnumerable<Case> SameNode(FlowItem read, string key, int seed)
    {
        var random = new Random(FlowBattery.StableSeed(seed, key, "same-node"));
        var nodes = read.Items.Where(i => i.Role == "node" && !i.Opaque).ToList();
        // part|part: the first value of two parts of one node.
        var pairs = new List<(string Node, SlotAt First, SlotAt Second)>();
        foreach (var node in nodes) {
            var slots = new List<SlotAt>();
            for (var p = 0; p < node.Items.Count; p++)
                if (node.Items[p].Role is "assignment" or "argument" or "filter" or "case"
                    && node.Items[p].Props.FirstOrDefault(v => Wrappable(v.Value) && !(node.Items[p].Role == "assignment" && v.Key == "Variable")) is { Key: { } name })
                    slots.Add(new(node.Key, p, name));
            if (slots.Count >= 2) pairs.Add((node.Key, slots[0], slots[1]));
        }
        if (pairs.Count > 0) {
            var (_, first, second) = pairs[random.Next(pairs.Count)];
            var s = read.Clone(); Wrap(s, first, 1);
            var m = read.Clone(); Wrap(m, second, 1);
            yield return new Case("part|part", true, s, m, null, theirs => { Wrap(theirs, second, 1); return theirs; });
        }
        // insert|part: the Studio adds an assignment at the end of an assign (its first variable, to itself); the model changes
        // the first one's value.
        var assigns = nodes.Where(n => n.Kind == "AssignNode" && n.Items.FindIndex(p => p.Role == "assignment") is var at && at >= 0
            && n.Items[at].Prop("Variable") is { Length: > 0 } && n.Items[at].Props.TryGetValue("Value", out var value) && Wrappable(value)).ToList();
        if (assigns.Count > 0) {
            var node = assigns[random.Next(assigns.Count)];
            var first = node.Items.FindIndex(p => p.Role == "assignment");
            var variable = node.Items[first].Prop("Variable")!;
            var s = read.Clone();
            var added = new FlowItem("assignment", "Assignment");
            added.Props["Variable"] = new('e', variable); added.Props["Value"] = new('e', variable);
            var studioNode = s.Items.First(i => i.Key == node.Key);
            studioNode.Items.Insert(studioNode.Items.FindLastIndex(p => p.Role == "assignment") + 1, added);
            var slot = new SlotAt(node.Key, first, "Value");
            var m = read.Clone(); Wrap(m, slot, 1);
            yield return new Case("insert|part", true, s, m, null, theirs => { Wrap(theirs, slot, 1); return theirs; });
        }
        // code|code and code-same-line: a SQL or JavaScript text of three lines or more.
        var code = nodes.Where(n => n.Kind is "SQLNode" or "JavaScriptNode" && n.Props.TryGetValue(n.Kind == "SQLNode" ? "Statement" : "JavaScript", out var text)
            && text.Type == 't' && text.Text.Split('\n').Count(l => l.Trim().Length > 0) >= 3).ToList();
        if (code.Count > 0) {
            var node = code[random.Next(code.Count)];
            var property = node.Kind == "SQLNode" ? "Statement" : "JavaScript";
            string Last(string text, string comment)
            {
                var lines = text.Split('\n');
                var at = Array.FindLastIndex(lines, l => l.Trim().Length > 0);
                lines[at] += " /* " + comment + " */";
                return string.Join('\n', lines);
            }
            FlowItem With(FlowItem action, Func<string, string> change)
            {
                var owner = action.Items.First(i => i.Key == node.Key);
                owner.Props[property] = new('t', change(owner.Props[property].Text));
                return action;
            }
            yield return new Case("code|code", true, With(read.Clone(), t => "/* studio */\n" + t), With(read.Clone(), t => Last(t, "model")), null,
                theirs => With(theirs, t => Last(t, "model")));
            var model = With(read.Clone(), t => Last(t, "model"));
            var delivered = model.Items.First(i => i.Key == node.Key).Props[property];
            yield return new Case("code-same-line", false, With(read.Clone(), t => Last(t, "studio")), model, node.Key,
                theirs => { theirs.Items.First(i => i.Key == node.Key).Props[property] = delivered; return theirs; });
        }
    }

    // A value wrapped in parentheses must read back as written: one line, no space at its ends (the platform lays out nested
    // parentheses around those again), and never a mapping nor a record literal (the whole value of an argument: the ODC
    // parser reads neither inside parentheses).
    private static bool Wrappable(FlowValue value) => value.Type == 'e' && value.Text.Length > 0 && !value.Text.Contains(" mapTo {", StringComparison.Ordinal)
        && FlowMapping.SplitRecord(value.Text) == null
        && value.Text.Trim() == value.Text && !value.Text.Contains('\n') && !value.Text.Contains('\r');

    // The Studio's new nodes get names of their own (StudioCall), so the model's new nodes keep theirs.
    private static void StudioNames(FlowItem edited, FlowItem read)
    {
        var taken = read.Items.Where(i => i.Role == "node").Select(i => i.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var node in edited.Items.Where(i => i.Role == "node" && i.Key.StartsWith("new", StringComparison.Ordinal) && i.Name.StartsWith("FlowCall", StringComparison.Ordinal))) {
            var name = "StudioCall";
            for (var n = 2; taken.Contains(name); n++) name = "StudioCall" + n;
            node.Name = name; taken.Add(name);
        }
    }

    private sealed record SlotAt(string Node, int Part, string Property);

    // An expression of a node (its own property, or a property of one of its assignments, arguments, filters or cases).
    private static SlotAt? Slot(FlowItem action, int seed, string? only)
    {
        var slots = new List<SlotAt>();
        // A value wrapped twice must read back as written (Wrappable), and never the variable an assignment writes (a target).
        foreach (var node in action.Items.Where(i => i.Role == "node" && !i.Opaque && (only == null || i.Key == only))) {
            foreach (var (name, value) in node.Props) if (Wrappable(value)) slots.Add(new(node.Key, -1, name));
            for (var p = 0; p < node.Items.Count; p++)
                if (node.Items[p].Role is "assignment" or "argument" or "filter" or "case")
                    foreach (var (name, value) in node.Items[p].Props)
                        if (Wrappable(value) && !(node.Items[p].Role == "assignment" && name == "Variable")) slots.Add(new(node.Key, p, name));
        }
        return slots.Count == 0 ? null : slots[new Random(seed).Next(slots.Count)];
    }

    private static void Wrap(FlowItem action, SlotAt slot, int times)
    {
        var node = action.Items.First(i => i.Key == slot.Node);
        var owner = slot.Part < 0 ? node : node.Items[slot.Part];
        var text = owner.Props[slot.Property].Text;
        for (var i = 0; i < times; i++) text = "(" + text + ")";
        owner.Props[slot.Property] = new('e', text);
    }

    // ---- one case --------------------------------------------------------------------------------------------------------------

    private sealed record Outcome(string? Why, int Conflicts);

    private static Outcome RunCase(ModelSession session, IObjectSignature root, KernelModelReader reader, IObjectSignature action, FlowItem @base, FlowDocument read,
        Case study, Dictionary<string, FlowReading> readings, string lane, bool bare)
    {
        var sha = ModuleFlow.TextSha(read.Text);
        readings[sha] = new FlowReading(lane, "", @base.Key, @base.Kind, @base.Name, read.Text, read.Keys);
        var keyToId = read.Keys.Where(p => p.Key != "start").ToDictionary(p => p.Value, p => p.Key, StringComparer.Ordinal);
        // The Studio: its edit written on the read (the action now differs from the read).
        var studioText = ModuleFlow.Print(study.Studio, keyToId).Text;
        if (!Apply(session, studioText, sha, out var studioReceipt, out var why)) return new("the Studio edit did not apply: " + why, 0);
        var theirs = ModuleFlow.Extract(root, reader, action, out _);
        // The model: its text written on the same read, merged.
        var modelText = ModuleFlow.Print(study.Model, keyToId).Text;
        if (bare && !modelText.Contains("-> @new", StringComparison.Ordinal)) modelText = NewId.Replace(modelText, "");
        if (!Apply(session, modelText, sha, out var receipt, out why)) return new("the merged text did not apply: " + why, 0);
        var conflicts = receipt!["merged"]?["conflicts"] as JsonArray;
        var after = ModuleFlow.Extract(root, reader, action, out var problems);
        if (problems.Count > 0) return new("read back with problems: " + string.Join("; ", problems.Take(2)), conflicts?.Count ?? 0);
        if (receipt["merged"] is not JsonObject) return new("the text was not merged (no merged note)", 0);
        var model = ModuleFlow.Read(modelText, read.Keys);
        var created = receipt["keys"]!.AsObject().ToDictionary(p => p.Key, p => p.Value!.ToString(), StringComparer.Ordinal);
        var expected = Expected(study, @base, theirs, model, created, out var wantConflict);
        if (expected == null) return new("no expectation for the case", conflicts?.Count ?? 0);
        if (study.Disjoint && conflicts is { Count: > 0 }) return new("disjoint edits listed conflicts: " + conflicts.ToJsonString(), conflicts.Count);
        if (!study.Disjoint) {
            if (conflicts is not { Count: > 0 }) return new("overlapping edits listed no conflict", 0);
            if (wantConflict != null && !conflicts.Any(c => c?["key"]?.ToString() == wantConflict)) return new("the conflict of @" + wantConflict + " is not listed: " + conflicts.ToJsonString(), conflicts.Count);
        }
        var want = expected.Canon(); var got = after.Canon();
        if (want == got) return new(null, conflicts?.Count ?? 0);
        return new("reads back otherwise: " + FirstDifference(want, got), conflicts?.Count ?? 0);
    }

    // The action as it must read: the Studio's (theirs, read back) with what the model wrote where it wrote, by the rule of the case.
    private static FlowItem? Expected(Case study, FlowItem @base, FlowItem theirs, FlowItem model, Dictionary<string, string> created, out string? wantConflict)
    {
        wantConflict = study.Key;
        if (study.Expect != null) return study.Expect(theirs.Clone());
        var baseKeys = Elements(@base).Keys.ToHashSet(StringComparer.Ordinal);
        var studioRenames = Renames(@base, theirs); var modelRenames = Renames(@base, model);
        var expected = theirs.Clone();
        var touched = Touched(@base, model);
        var newKey = new Dictionary<string, string>(StringComparer.Ordinal);
        string Rekey(string key) => created.TryGetValue(key, out var real) ? real : newKey.TryGetValue(key, out var mapped) ? mapped : key;
        switch (study.Name) {
            case "changed-removed": {
                // The node the Studio removed comes back as the model wrote it, under the key its create gave (id +m1), and the
                // connectors the model kept to it go to it again.
                var gone = study.Key!;
                if (!created.TryGetValue(FlowParser.FreshPrefix + "m1", out var again)) return null;
                newKey[gone] = again;
                touched.UnionWith(Removed(@base, StudioOf(theirs, @base)).Concat(PredecessorsIn(@base, gone)));
                break;
            }
            case "both-insert": {
                // The model's call, then the Studio's, after the same node.
                var after = study.Key;
                var studioNew = theirs.Items.FirstOrDefault(i => i.Role == "node" && !baseKeys.Contains(i.Key));
                var modelNew = model.Items.FirstOrDefault(i => i.Role == "node" && !baseKeys.Contains(i.Key));
                if (after == null || studioNew == null || modelNew == null) return null;
                var modelCopy = Normalized(modelNew, studioRenames);
                modelCopy.Edges["Target"] = studioNew.Key;
                modelCopy.Key = Rekey(modelNew.Key);
                Override(expected, model.Items.First(i => i.Key == after), studioRenames, Rekey);
                expected.Items.First(i => i.Key == after).Edges["Target"] = modelCopy.Key;
                expected.Items.Add(modelCopy);
                return expected;
            }
        }
        // The action itself (name, properties, events) when the model changed it.
        if (touched.Contains(@base.Key)) {
            expected.Name = model.Name;
            expected.Props.Clear(); foreach (var (n, v) in model.Props) expected.Props[n] = v;
            expected.Items.RemoveAll(i => i.Role == "event"); expected.Items.InsertRange(0, model.Items.Where(i => i.Role == "event").Select(i => i.Clone()));
        }
        foreach (var key in touched.Where(k => k != @base.Key)) {
            var mine = model.Items.FirstOrDefault(i => i.Key == key);
            var at = expected.Items.FindIndex(i => i.Key == key);
            if (mine == null) { if (at >= 0) expected.Items.RemoveAt(at); continue; }
            var copy = Override(null, mine, studioRenames, Rekey);
            if (newKey.TryGetValue(key, out var again)) copy.Key = again;
            if (at >= 0) expected.Items[at] = copy;
            else if (baseKeys.Contains(key) && !newKey.ContainsKey(key)) continue;   // removed in the Studio, not written again
            else expected.Items.Add(copy);
        }
        // The Studio's new elements read in the model's names.
        foreach (var item in expected.Items.Where(i => FlowItem.Keyed(i.Role) && !baseKeys.Contains(i.Key) && theirs.Items.Any(t => t.Key == i.Key)).ToList()) {
            var at = expected.Items.IndexOf(item);
            expected.Items[at] = Normalized(item, modelRenames);
        }
        if (modelRenames.Count > 0)
            foreach (var item in expected.Items.Where(i => FlowItem.Keyed(i.Role) && baseKeys.Contains(i.Key) && !touched.Contains(i.Key)).ToList()) {
                var at = expected.Items.IndexOf(item);
                expected.Items[at] = Normalized(item, modelRenames);
            }
        return expected;
    }

    // The model's element in the expected action: the Studio's renames applied, its connectors and key in the keys after.
    private static FlowItem Override(FlowItem? expected, FlowItem mine, List<(string From, string To)> renames, Func<string, string> rekey)
    {
        var copy = Normalized(mine, renames);
        copy.Key = rekey(copy.Key);
        foreach (var (edge, to) in copy.Edges.ToList()) if (to.Length > 0) copy.Edges[edge] = rekey(to);
        foreach (var part in copy.Items.Where(p => p.Role == "case")) if (part.Edges.TryGetValue("Target", out var to) && to.Length > 0) part.Edges["Target"] = rekey(to);
        foreach (var parameter in copy.Items.Where(p => FlowItem.Keyed(p.Role))) parameter.Key = rekey(parameter.Key);
        if (expected != null) {
            var at = expected.Items.FindIndex(i => i.Key == mine.Key);
            if (at >= 0) expected.Items[at] = copy; else expected.Items.Add(copy);
        }
        return copy;
    }

    private static FlowItem StudioOf(FlowItem theirs, FlowItem @base) => theirs;

    private static IEnumerable<string> PredecessorsIn(FlowItem action, string key) =>
        action.Items.Where(i => i.Role == "node" && (i.Edges.Any(e => e.Value == key) || i.Items.Any(p => p.Role == "case" && p.Edges.GetValueOrDefault("Target") == key))).Select(i => i.Key);

    private static FlowItem Normalized(FlowItem item, List<(string From, string To)> renames)
    {
        var copy = item.Clone();
        if (renames.Count == 0) return copy;
        void Visit(FlowItem x)
        {
            foreach (var (name, value) in x.Props.ToList())
                if (value.Type == 'e') { var text = value.Text; foreach (var (from, to) in renames) text = FlowEdits.Renamed(text, from, to); x.Props[name] = new('e', text); }
            foreach (var child in x.Items) Visit(child);
        }
        Visit(copy);
        return copy;
    }

    // Parameters and locals one side renamed (same key, another name).
    private static List<(string From, string To)> Renames(FlowItem @base, FlowItem side)
    {
        var names = side.Items.Where(i => i.Role is "in" or "out" or "local").ToDictionary(i => i.Key, i => i.Name, StringComparer.Ordinal);
        return @base.Items.Where(i => i.Role is "in" or "out" or "local" && names.TryGetValue(i.Key, out var now) && now != i.Name).Select(i => (i.Name, names[i.Key])).ToList();
    }

    // The keyed elements of an action by key (its parameters, locals and nodes; the action itself by its own properties and events).
    private static Dictionary<string, string> Elements(FlowItem action)
    {
        var own = new FlowItem("action", action.Kind, action.Key, action.Name);
        foreach (var (n, v) in action.Props) own.Props[n] = v;
        foreach (var e in action.Items.Where(i => i.Role == "event")) own.Items.Add(e.Clone());
        var map = new Dictionary<string, string>(StringComparer.Ordinal) { [action.Key] = own.Canon() };
        foreach (var item in action.Items.Where(i => FlowItem.Keyed(i.Role))) map[item.Key] = item.Canon();
        return map;
    }

    private static HashSet<string> Touched(FlowItem @base, FlowItem edited)
    {
        var a = Elements(@base); var b = Elements(edited);
        var touched = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (key, canon) in a) if (!b.TryGetValue(key, out var now) || now != canon) touched.Add(key);
        foreach (var key in b.Keys) if (!a.ContainsKey(key)) touched.Add(key);
        return touched;
    }

    private static List<string> Removed(FlowItem @base, FlowItem edited)
    {
        var now = edited.Items.Where(i => i.Role == "node").Select(i => i.Key).ToHashSet(StringComparer.Ordinal);
        return @base.Items.Where(i => i.Role == "node" && !now.Contains(i.Key)).Select(i => i.Key).ToList();
    }

    // Whether a node the edit touched goes to one of the keys (the nodes it did not touch go where the read went).
    private static bool GoesTo(FlowItem edited, HashSet<string> touched, List<string> keys) =>
        keys.Count > 0 && edited.Items.Where(i => i.Role == "node" && touched.Contains(i.Key))
            .Any(n => n.Edges.Values.Any(keys.Contains) || n.Items.Any(p => p.Role == "case" && keys.Contains(p.Edges.GetValueOrDefault("Target") ?? "")));

    // ---- writing ---------------------------------------------------------------------------------------------------------------

    private static bool Apply(ModelSession session, string text, string basedOn, out JsonObject? receipt, out string why)
    {
        JsonObject? result = null;
        why = "";
        try { session.Mutate("Anvil: flow merge battery", () => result = session.ApplyFlowText(text, basedOn)); }
        catch (Exception error) {
            var coded = Errors.FindCoded(error);
            why = (coded?.Code ?? error.GetBaseException().GetType().Name) + ": " + Clip(Errors.Text(error));
            receipt = null;
            // FLOW_BATTERY_DEBUG=<folder>: the write that threw, whole (the text and the exception), as FlowBattery writes it.
            if (Environment.GetEnvironmentVariable("FLOW_BATTERY_DEBUG") is { Length: > 0 } folder) {
                Directory.CreateDirectory(folder);
                File.WriteAllText(Path.Combine(folder, "merge-" + DateTime.UtcNow.Ticks + ".txt"), why + "\n\n=== text\n" + text + "\n=== error\n" + error + "\n");
            }
            return false;
        }
        receipt = result;
        return true;
    }

    // The read written back over the action as it is now (its kept elements by the ids of this read, the others as new).
    private static bool Undo(ModelSession session, IObjectSignature root, KernelModelReader reader, IObjectSignature action, FlowItem @base)
    {
        var now = ModuleFlow.Extract(root, reader, action, out var problems);
        if (problems.Count > 0) return false;
        if (now.Canon() == @base.Canon()) return true;
        var read = ModuleFlow.Print(now);
        var ids = read.Keys.ToDictionary(p => p.Value, p => p.Key, StringComparer.Ordinal);
        var back = new Dictionary<string, string>(StringComparer.Ordinal);
        var fresh = 0;
        foreach (var element in ModuleFlow.Print(@base).Keys.Values) back[element] = ids.TryGetValue(element, out var id) ? id : "new" + ++fresh;
        var text = ModuleFlow.Print(@base, back).Text;
        // The undo writes back what the read had: a JavaScript node a case removed is that node again (decision 6 judges what a
        // model writes new), as FlowBattery's undo.
        session.FlowRestore = @base;
        try { return Apply(session, text, ModuleFlow.TextSha(read.Text), out _, out _); }
        finally { session.FlowRestore = null; }
    }

    private static string FirstDifference(string expected, string actual)
    {
        var a = expected.Split('\n'); var b = actual.Split('\n');
        for (var i = 0; i < Math.Max(a.Length, b.Length); i++) {
            var x = i < a.Length ? a[i] : "(end)"; var y = i < b.Length ? b[i] : "(end)";
            if (x != y) return "line " + (i + 1) + ": expected " + Clip(x.Trim()) + " | got " + Clip(y.Trim());
        }
        return "(same lines)";
    }

    private static string Clip(string text) => text.Length <= 300 ? text : text[..300] + "…";

    private static bool UnderReference(KernelModelReader reader, IObjectSignature node, IObjectSignature root)
    {
        for (var at = reader.ParentOf(node); at != null && !ReferenceEquals(at, root); at = reader.ParentOf(at))
            if (reader.KindOf(at) == "Reference") return true;
        return false;
    }
}
