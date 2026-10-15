using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;
using OutSystems.Model;
using ESpace = ServiceStudio.Model.ESpace;


namespace Anvil.Core;

/// <summary>
/// The battery of stage LG2 (PLANO.md section 8): synthetic edits of real actions, each written back through the logic op's
/// text form (ModelSession.ApplyFlowText) on the loaded module and read again. An edit passes when the action reads back as
/// exactly the edited text: the same text printed with the read's ids, so every element the edit did not touch keeps its
/// key, and every new element has the key its create gave. Each edit is then undone the same way (the text of the action
/// before it, written back over the edited one: a removed node comes back, an inserted one goes) and checked the same way.
/// One module is loaded once; the edits of one action run one after the other on the action as it is.
/// Kinds (FlowEdits): expression, call, remove, branch, rename, swap. Half the new lines (by seed) are written without an
/// id, as a model writes them.
/// </summary>
public static class FlowBattery
{
    public sealed class Tally
    {
        public int Actions, Skipped, Edits, Exact, Reverts, RevertsExact, Verified, VerifyRefused;
        public double ApplyMs, ReadMs, LoadMs, InnerMs;
        public readonly SortedDictionary<string, int> ByKind = new(StringComparer.Ordinal);
        public readonly SortedDictionary<string, int> ExactByKind = new(StringComparer.Ordinal);
        public readonly SortedDictionary<string, int> Ops = new(StringComparer.Ordinal);
        public readonly SortedDictionary<string, double> Phases = new(StringComparer.Ordinal);
        public readonly List<string> Failures = [];
        public JsonObject ToJson() => new() {
            ["actions"] = Actions, ["skipped"] = Skipped, ["edits"] = Edits, ["exact"] = Exact, ["reverts"] = Reverts, ["revertsExact"] = RevertsExact,
            ["verified"] = Verified, ["verifyRefused"] = VerifyRefused,
            ["byKind"] = new JsonObject(ByKind.Select(p => KeyValuePair.Create(p.Key, (JsonNode?)p.Value))),
            ["exactByKind"] = new JsonObject(ExactByKind.Select(p => KeyValuePair.Create(p.Key, (JsonNode?)p.Value))),
            ["ops"] = new JsonObject(Ops.Select(p => KeyValuePair.Create(p.Key, (JsonNode?)p.Value))),
            ["ms"] = new JsonObject { ["load"] = Math.Round(LoadMs), ["apply"] = Math.Round(ApplyMs), ["read"] = Math.Round(ReadMs), ["inner"] = Math.Round(InnerMs), ["phases"] = new JsonObject(Phases.Select(p => KeyValuePair.Create(p.Key, (JsonNode?)Math.Round(p.Value)))) },
            ["failures"] = new JsonArray(Failures.Take(40).Select(f => (JsonNode)f).ToArray()) };
        public void Add(Tally other)
        {
            ApplyMs += other.ApplyMs; ReadMs += other.ReadMs; LoadMs += other.LoadMs;
            Actions += other.Actions; Skipped += other.Skipped; Edits += other.Edits; Exact += other.Exact; Reverts += other.Reverts; RevertsExact += other.RevertsExact;
            Verified += other.Verified; VerifyRefused += other.VerifyRefused;
            foreach (var (k, v) in other.ByKind) ByKind[k] = ByKind.GetValueOrDefault(k) + v;
            foreach (var (k, v) in other.ExactByKind) ExactByKind[k] = ExactByKind.GetValueOrDefault(k) + v;
            foreach (var (k, v) in other.Ops) Ops[k] = Ops.GetValueOrDefault(k) + v;
            Failures.AddRange(other.Failures);
        }
    }

    // The last write that threw, whole (FLOW_BATTERY_DEBUG writes it beside the failure).
    [ThreadStatic] private static string? lastError;

    private static readonly Regex NewId = new(@" @(new[0-9]+|\+[0-9]+)$", RegexOptions.Multiline | RegexOptions.CultureInvariant);

    /// <summary>The battery over one module. every: one action in every (1 = all); kinds: the edit kinds (all by default).</summary>
    public static Tally Run(ModelHost host, byte[] oml, string label, int seed = 1, int every = 1, IReadOnlyList<string>? kinds = null, Action<string>? log = null)
    {
        var tally = new Tally();
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var reader = new KernelModelReader();
        ESpace? espace = null;
        ModelSession session = null!;
        IObjectSignature root = null!;
        Dictionary<string, IObjectSignature> byKey = null!;
        // One edit in every FLOW_BATTERY_VERIFY is exact only without a new Verify error under its action (BatteryVerify).
        var verify = new BatteryVerify();
        // A write that failed may leave the module half written (the command is not undone): the module is loaded again.
        void Load()
        {
            if (espace != null) ModelHost.Release(espace);
            var started = clock.Elapsed.TotalMilliseconds;
            espace = host.Load(oml);
            verify.Module = espace;
            tally.LoadMs += clock.Elapsed.TotalMilliseconds - started;
            session = new ModelSession(espace);
            root = (IObjectSignature)espace;
            byKey = reader.Walk(root).Where(n => ModuleFlow.ActionKinds.Contains(reader.KindOf(n)) && !UnderReference(reader, n, root))
                .ToDictionary(reader.KeyOf, StringComparer.Ordinal);
        }
        // FLOW_BATTERY_PERF=1: the native phases of the run, slowest first, in the log.
        using var capture = Environment.GetEnvironmentVariable("FLOW_BATTERY_PERF") is { Length: > 0 } ? NativePerformanceCapture.Begin() : null;
        try {
            Load();
            var keys = byKey.Keys.Order(StringComparer.Ordinal).ToList();
            // The calls of the module by flow kind: what a "call" edit inserts when its action calls nothing.
            var calls = new Dictionary<bool, List<FlowItem>> { [true] = [], [false] = [] };
            // The map edit (O11 mapping battery): the record types of the module and a ListAppendAll call per kind of flow.
            var appendAll = new Dictionary<bool, FlowItem>();
            var mandatory = new Dictionary<string, IReadOnlySet<string>>(StringComparer.Ordinal);
            var mapTypes = kinds?.Contains("map") == true ? new FlowEdits.MapTypes(RecordTypes(reader, root, mandatory), appendAll, mandatory) : null;
            foreach (var key in keys) {
                var item = ModuleFlow.Extract(root, reader, byKey[key], out _);
                if (mapTypes != null && item.Items.FirstOrDefault(i => i.Role == "node" && i.Kind == "Execute" && !i.Opaque && i.Prop("Action") == "(System).ListAppendAll") is { } append)
                    appendAll.TryAdd(append.CallKind == "Client", append);
                // Calls of module actions only: a screen action's calls may name actions of its own screen.
                if (item.Kind is not ("ServerAction" or "ServiceAction" or "ClientAction")) continue;
                var client = item.Kind == "ClientAction";
                foreach (var call in item.Items.Where(i => i.Role == "node" && i.Kind == "Execute" && !i.Opaque).Take(2)) calls[client].Add(call);
            }
            var index = 0;
            foreach (var key in keys) {
                if (index++ % every != 0) continue;
                if (index % 100 == 0) log?.Invoke(label + ": " + index + "/" + keys.Count + " actions, " + tally.Edits + " edits, " + clock.Elapsed.TotalSeconds.ToString("0") + " s");
                // FLOW_BATTERY_ONLY=<text>: only the actions whose name contains it (a failure looked at again).
                if (Environment.GetEnvironmentVariable("FLOW_BATTERY_ONLY") is { Length: > 0 } only && !reader.DisplayOf(byKey[key]).Contains(only, StringComparison.Ordinal)) continue;
                tally.Actions++;
                var name = label + " " + reader.DisplayOf(byKey[key]);
                foreach (var kind in kinds ?? FlowEdits.Kinds) {
                    var action = byKey[key];
                    var current = ModuleFlow.Extract(root, reader, action, out var problems);
                    var read = ModuleFlow.Print(current);
                    if (problems.Count > 0 || read.Unprintable.Count > 0) { tally.Skipped++; break; }
                    var actionSeed = StableSeed(seed, key, kind);
                    FlowEdits.Edit? edit;
                    (string Source, IReadOnlyList<(string Field, string Value)> Fields, IReadOnlySet<string> Mandatory)? mapped = null;
                    if (kind == "map") {
                        var map = mapTypes == null ? null : FlowEdits.Map(current, actionSeed, mapTypes, ClientFlow(reader, action));
                        edit = map?.Edit;
                        if (map is { } m) mapped = (m.Source, m.Fields, m.Mandatory);
                    } else edit = FlowEdits.Make(current, kind, actionSeed, calls);
                    if (edit == null) continue;
                    var keyToId = read.Keys.ToDictionary(p => p.Value, p => p.Key, StringComparer.Ordinal);
                    var text = ModuleFlow.Print(edit.Model, keyToId).Text;
                    // Half the edits write their new lines as a model does: without an id (none of them is the target of a jump).
                    var bare = actionSeed % 2 == 1 && !text.Contains("-> @new", StringComparison.Ordinal);
                    if (bare) text = NewId.Replace(text, "");
                    tally.Edits++; tally.ByKind[kind] = tally.ByKind.GetValueOrDefault(kind) + 1;
                    var check = verify.Sample();
                    if (check) verify.Before(action);
                    var forward = Write(session, action, root, reader, text, read.Text, keyToId, bare, out _, out var why, tally);
                    if (forward && check && verify.Added(action) is { Count: > 0 } added) { forward = false; why = "reads back as the text, and the Verify has new errors under the action: " + string.Join("; ", added.Take(3)); }
                    if (forward) { tally.Exact++; tally.ExactByKind[kind] = tally.ExactByKind.GetValueOrDefault(kind) + 1; }
                    else {
                        tally.Failures.Add(name + " [" + kind + ": " + edit.What + "] " + why); log?.Invoke("FAIL " + tally.Failures[^1]);
                        Debug(tally.Failures.Count, tally.Failures[^1], current, read, text);
                    }
                    var after = ModuleFlow.Extract(root, reader, action, out _);
                    if (Canon(after) == Canon(current)) continue;   // a refused edit left the action as it was
                    if (!forward) { Load(); break; }                 // half written: the module again, the next action
                    // map: the mapping just written is edited once more (remap: a field dropped, a value changed), over the
                    // action as it reads now, before the undo.
                    if (mapped is { } written && Remapped(written.Source, written.Fields, written.Mandatory) is { } remap) {
                        var mid = ModuleFlow.Print(after);
                        var remapText = mid.Text.Replace(remap.Was, remap.Now);
                        var midIds = mid.Keys.ToDictionary(p => p.Value, p => p.Key, StringComparer.Ordinal);
                        tally.Edits++; tally.ByKind["remap"] = tally.ByKind.GetValueOrDefault("remap") + 1;
                        var remapWhy = "the mapping is not in the text";
                        if (remapText != mid.Text && Write(session, action, root, reader, remapText, mid.Text, midIds, false, out _, out remapWhy, tally)) {
                            tally.Exact++; tally.ExactByKind["remap"] = tally.ExactByKind.GetValueOrDefault("remap") + 1;
                        } else {
                            tally.Failures.Add(name + " [remap: " + remap.Was + " -> " + remap.Now + "] " + remapWhy);
                            log?.Invoke("FAIL " + tally.Failures[^1]);
                            Debug(tally.Failures.Count, tally.Failures[^1], after, mid, remapText);
                            Load();
                            break;
                        }
                        after = ModuleFlow.Extract(root, reader, action, out _);
                    }
                    // Undo: the text of the action before the edit, over the action as it is now (its kept elements by the
                    // ids of this read, the ones the edit removed as new lines).
                    var now = ModuleFlow.Print(after);
                    var nowIds = now.Keys.ToDictionary(p => p.Value, p => p.Key, StringComparer.Ordinal);
                    var back = new Dictionary<string, string>(StringComparer.Ordinal);
                    var fresh = 0;
                    foreach (var (element, _) in keyToId) back[element] = nowIds.TryGetValue(element, out var id) ? id : "new" + ++fresh;
                    var undo = ModuleFlow.Print(current, back).Text;
                    tally.Reverts++;
                    // The undo writes back what the read had: a JavaScript node the edit removed is that node again (decision 6
                    // judges what a model writes new).
                    session.FlowRestore = current;
                    bool reverted;
                    string undoWhy;
                    try { reverted = Write(session, action, root, reader, undo, now.Text, back, false, out _, out undoWhy, tally); }
                    finally { session.FlowRestore = null; }
                    if (reverted) tally.RevertsExact++;
                    else {
                        tally.Failures.Add(name + " [undo " + kind + ": " + edit.What + "] " + undoWhy);
                        log?.Invoke("FAIL " + tally.Failures[^1]);
                        Debug(tally.Failures.Count, tally.Failures[^1], after, now, undo);
                        // The action is not what the next edit expects: the module again, the next action.
                        Load();
                        break;
                    }
                }
            }
        } finally { if (espace != null) ModelHost.Release(espace); }
        tally.Verified = verify.Verified; tally.VerifyRefused = verify.Refused;
        if (capture != null)
            foreach (var (phase, metric) in capture.Snapshot().Phases.OrderByDescending(p => p.Value.WallMs).Take(25))
                log?.Invoke("perf " + phase + ": " + metric.Calls + " calls, " + Math.Round(metric.WallMs) + " ms");
        return tally;
    }

    // The remap of a mapping the battery wrote: with two fields or more the last is dropped (never one of the mandatory ones,
    // `mandatory`), and the first value is put in parentheses (as a person would edit it). Was and Now are the two mapping texts.
    private static (string Was, string Now)? Remapped(string source, IReadOnlyList<(string Field, string Value)> fields, IReadOnlySet<string> mandatory)
    {
        if (fields.Count == 0) return null;
        var now = fields.ToList();
        var last = now.FindLastIndex(f => !mandatory.Contains(f.Field));
        if (now.Count >= 2 && last >= 0) now.RemoveAt(last);
        now[0] = (now[0].Field, "(" + now[0].Value + ")");
        return FlowMapping.Compose(source, fields) is { } was && FlowMapping.Compose(source, now) is { } changed ? (was, changed) : null;
    }

    // A client flow: a client action or a screen action of a reactive or mobile screen (the extractor's rule).
    private static bool ClientFlow(KernelModelReader reader, IObjectSignature action) =>
        reader.IsKind(action, "IClientAction") || reader.IsKind(action, "OutSystems.Model.UI.Mobile.IScreenAction");

    // The record types a map edit maps between: the structures and the (non static) entities of the module and its
    // references, by the name the text gives a type, with their attributes and the text of each attribute's type (the
    // identifier of an entity as "<Entity> Identifier"); a name two of them share is left out (the text could not say which
    // one). mandatory: the attributes of each type the Verify needs mapped (IsMandatory).
    private static Dictionary<string, IReadOnlyList<(string Name, string Type)>> RecordTypes(KernelModelReader reader, IObjectSignature root, Dictionary<string, IReadOnlySet<string>> mandatory)
    {
        var records = new Dictionary<string, IReadOnlyList<(string Name, string Type)>>(StringComparer.Ordinal);
        var twice = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in reader.Walk(root)) {
            var kind = reader.KindOf(node);
            if (kind.Contains("Static", StringComparison.Ordinal) || !(reader.IsKind(node, "IStructureSignature") || reader.IsKind(node, "IEntitySignature"))) continue;
            var name = reader.DisplayOf(node);
            if (name.Length == 0 || records.ContainsKey(name) || twice.Contains(name)) { if (name.Length > 0 && records.Remove(name)) twice.Add(name); continue; }
            // Only a type the module can name: what the text's DataType resolves (a structure of a reference the module
            // does not expose by that name is no type a person can write).
            try { if (root is IESpace module) TypeResolver.Resolve(module, name); } catch { continue; }
            var attributes = new List<(string Name, string Type)>();
            var required = new HashSet<string>(StringComparer.Ordinal);
            object? identifier = null;
            try { identifier = reader.PropertyOf(node, "IdentifierAttribute")?.Invoke(); } catch { }
            foreach (var attribute in reader.ChildrenOf(node).Where(c => reader.KindOf(c).EndsWith("Attribute", StringComparison.Ordinal))) {
                object? type;
                try { type = reader.PropertyOf(attribute, "DataType")?.Invoke(); } catch { continue; }
                var text = ReferenceEquals(attribute, identifier) ? name + " Identifier" : type is IObjectSignature named ? reader.DisplayOf(named) : type?.ToString() ?? "";
                attributes.Add((reader.NameOf(attribute), text));
                // The identifier of an entity is mandatory in a mapping (AttributeMappingRequiredExpression), whatever its own flag.
                try { if (ReferenceEquals(attribute, identifier) || reader.PropertyOf(attribute, "IsMandatory")?.Invoke() is true) required.Add(reader.NameOf(attribute)); } catch { }
            }
            records[name] = attributes;
            mandatory[name] = required;
        }
        foreach (var name in twice) records.Remove(name);
        return records;
    }

    // Writes one text over the action and reads it back: true when it reads as exactly that text.
    private static bool Write(ModelSession session, IObjectSignature action, IObjectSignature root, KernelModelReader reader, string text, string readText,
        Dictionary<string, string> keyToId, bool bare, out Dictionary<string, string> created, out string why, Tally tally)
    {
        created = new(StringComparer.Ordinal);
        why = "";
        JsonObject? receipt = null;
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var inner = System.Diagnostics.Stopwatch.StartNew(); inner.Stop();
        try { session.Mutate("Anvil: flow battery", () => { inner.Start(); receipt = session.ApplyFlowText(text, ModuleFlow.TextSha(readText)); inner.Stop(); }); }
        catch (Exception error) {
            lastError = error.ToString();
            var coded = Errors.FindCoded(error);
            why = (coded?.Code ?? error.GetBaseException().GetType().Name) + ": " + Clip(Errors.Text(error));
            return false;
        }
        finally { tally.ApplyMs += clock.Elapsed.TotalMilliseconds; tally.InnerMs += inner.Elapsed.TotalMilliseconds; }
        clock.Restart();
        try { return ReadBack(action, root, reader, text, keyToId, bare, receipt!, created, out why, tally); }
        finally { tally.ReadMs += clock.Elapsed.TotalMilliseconds; }
    }

    private static bool ReadBack(IObjectSignature action, IObjectSignature root, KernelModelReader reader, string text, Dictionary<string, string> keyToId, bool bare,
        JsonObject receipt, Dictionary<string, string> created, out string why, Tally tally)
    {
        why = "";
        foreach (var (id, key) in receipt!["keys"]!.AsObject()) created[id] = key!.ToString();
        foreach (var (op, count) in receipt["ops"]!.AsObject()) tally.Ops[op] = tally.Ops.GetValueOrDefault(op) + count!.GetValue<int>();
        foreach (var (phase, value) in receipt["ms"]!.AsObject()) tally.Phases[phase] = tally.Phases.GetValueOrDefault(phase) + value!.GetValue<double>();
        var after = ModuleFlow.Extract(root, reader, action, out var problems);
        if (problems.Count > 0) { why = "read back with problems: " + string.Join("; ", problems.Take(3)); return false; }
        // The action printed with the read's ids for its kept elements and the text's ids for the new ones is the text.
        var ids = new Dictionary<string, string>(keyToId, StringComparer.Ordinal);
        foreach (var (id, key) in created) ids[key] = id;
        var back = ModuleFlow.Print(after, ids).Text;
        if (bare) back = NewId.Replace(back, "");
        if (back == text) return true;
        why = "reads back as other text: " + FirstDifference(text, back);
        return false;
    }

    private static string Canon(FlowItem item) => item.Canon();

    // The seed of one edit: the same for the same module, action and kind in every run (HashCode is random per process).
    internal static int StableSeed(int seed, string key, string kind)
    {
        var hash = 2166136261u ^ (uint)seed;
        foreach (var c in key + "|" + kind) { hash ^= c; hash *= 16777619u; }
        return (int)(hash & 0x7fffffff);
    }

    // FLOW_BATTERY_DEBUG=<folder>: each failure written there with the read, the text and the ops the diff made of it.
    private static void Debug(int n, string failure, FlowItem current, FlowDocument read, string text)
    {
        if (Environment.GetEnvironmentVariable("FLOW_BATTERY_DEBUG") is not { Length: > 0 } folder) return;
        Directory.CreateDirectory(folder);
        string ops;
        try {
            var diff = FlowDiff.Compute(current, read.Keys, ModuleFlow.Read(text), read.Text);
            ops = string.Join("\n", diff.Ops.Select(o => o.ToJsonString())) + "\n" + string.Join("\n", diff.Problems.Select(p => p.ToJson().ToJsonString()));
        } catch (Exception error) { ops = error.ToString(); }
        File.WriteAllText(Path.Combine(folder, n.ToString("D4") + ".txt"), failure + "\n\n=== read\n" + read.Text + "\n=== text\n" + text + "\n=== ops\n" + ops + "\n"
            + (lastError != null ? "\n=== error\n" + lastError + "\n" : ""));
        lastError = null;
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
