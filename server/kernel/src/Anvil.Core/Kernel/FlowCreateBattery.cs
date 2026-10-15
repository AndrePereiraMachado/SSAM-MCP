using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;
using OutSystems.Model;
using ESpace = ServiceStudio.Model.ESpace;

namespace Anvil.Core;

/// <summary>
/// The creation battery of the logic text: screen, block and data actions born from a text without @key whose header names
/// the owner (action Home.Save, data action Home.GetOrders), on real modules. For one owner in every <c>every</c> of the
/// screens and blocks that have screen or data actions, a new action of each of those kinds is written through the logic
/// op's text form (ModelSession.ApplyFlowText): the text of the first action of that owner and kind that is a fixed point
/// (no opaque node), under a new name, with every id renamed to an id no read gives and, for half of the actions (by seed),
/// the ids nothing jumps to left out, as a model writes a new action. A creation passes when the new action reads back as
/// exactly that text: printed with the ids the text gave (the keys the creates gave, by the receipt), it is the text.
/// One module is loaded once; a creation that throws loads it again.
/// An owner whose every template the owner's rules refuse new (decision 6: each of its screen actions runs a JavaScript; T1/T2:
/// a For Each that only builds a list) is created through the refusal's patch when the fix is certain (the owner's rule: one
/// refusal with every problem and a verified patch): the new client actions the patch adds first, then the corrected text, and
/// every one of them must read back as its text (counted in rules as "patched CODE").
/// </summary>
public static class FlowCreateBattery
{
    public sealed class Tally
    {
        public int Owners, Skipped, Traditional, Created, Exact, Verified, VerifyRefused;
        public double ApplyMs, LoadMs;
        public readonly SortedDictionary<string, int> ByKind = new(StringComparer.Ordinal);
        public readonly SortedDictionary<string, int> ExactByKind = new(StringComparer.Ordinal);
        public readonly SortedDictionary<string, int> Ops = new(StringComparer.Ordinal);
        // Templates whose text the owner's rules refuse new (a For Each that only filters, T1/T2), by code: the next template is taken.
        public readonly SortedDictionary<string, int> Rules = new(StringComparer.Ordinal);
        public readonly List<string> Failures = [];
        public JsonObject ToJson() => new() {
            ["owners"] = Owners, ["skipped"] = Skipped, ["traditional"] = Traditional, ["created"] = Created, ["exact"] = Exact,
            ["verified"] = Verified, ["verifyRefused"] = VerifyRefused,
            ["rules"] = new JsonObject(Rules.Select(p => KeyValuePair.Create(p.Key, (JsonNode?)p.Value))),
            ["byKind"] = new JsonObject(ByKind.Select(p => KeyValuePair.Create(p.Key, (JsonNode?)p.Value))),
            ["exactByKind"] = new JsonObject(ExactByKind.Select(p => KeyValuePair.Create(p.Key, (JsonNode?)p.Value))),
            ["ops"] = new JsonObject(Ops.Select(p => KeyValuePair.Create(p.Key, (JsonNode?)p.Value))),
            ["ms"] = new JsonObject { ["load"] = Math.Round(LoadMs), ["apply"] = Math.Round(ApplyMs) },
            ["failures"] = new JsonArray(Failures.Take(40).Select(f => (JsonNode)f).ToArray()) };
        public void Add(Tally other)
        {
            Owners += other.Owners; Skipped += other.Skipped; Traditional += other.Traditional; Created += other.Created; Exact += other.Exact;
            Verified += other.Verified; VerifyRefused += other.VerifyRefused;
            foreach (var (k, v) in other.Rules) Rules[k] = Rules.GetValueOrDefault(k) + v;
            ApplyMs += other.ApplyMs; LoadMs += other.LoadMs;
            foreach (var (k, v) in other.ByKind) ByKind[k] = ByKind.GetValueOrDefault(k) + v;
            foreach (var (k, v) in other.ExactByKind) ExactByKind[k] = ExactByKind.GetValueOrDefault(k) + v;
            foreach (var (k, v) in other.Ops) Ops[k] = Ops.GetValueOrDefault(k) + v;
            Failures.AddRange(other.Failures);
        }
    }

    public static readonly string[] Kinds = ["ScreenAction", "DataAction"];
    private static readonly Regex ReadId = new(@"(?<=^|\s)@([npl][0-9]+)(?=\s|$)", RegexOptions.Multiline | RegexOptions.CultureInvariant);
    private static readonly Regex Fresh = new(@" @\+[0-9]+$", RegexOptions.Multiline | RegexOptions.CultureInvariant);

    /// <summary>The battery over one module. every: one owner in every (1 = all).</summary>
    public static Tally Run(ModelHost host, byte[] oml, string label, int seed = 1, int every = 1, Action<string>? log = null)
    {
        var tally = new Tally();
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var reader = new KernelModelReader();
        ESpace? espace = null;
        ModelSession session = null!;
        IObjectSignature root = null!;
        Dictionary<string, IObjectSignature> owners = null!;
        // One creation in every FLOW_BATTERY_VERIFY is exact only without more Verify errors under the new action than its
        // template has (BatteryVerify).
        var verify = new BatteryVerify();
        void Load()
        {
            if (espace != null) ModelHost.Release(espace);
            var started = clock.Elapsed.TotalMilliseconds;
            espace = host.Load(oml);
            verify.Module = espace;
            tally.LoadMs += clock.Elapsed.TotalMilliseconds - started;
            session = new ModelSession(espace);
            root = (IObjectSignature)espace;
            // The owners of the module's screen and data actions, by key (none under a reference).
            owners = new Dictionary<string, IObjectSignature>(StringComparer.Ordinal);
            foreach (var node in reader.Walk(root))
                if (FlowOwners.Owned(reader.KindOf(node)) && reader.ParentOf(node) is { } parent && !ReferenceEquals(parent, root) && !UnderReference(reader, node, root))
                    owners.TryAdd(reader.KeyOf(parent), parent);
        }
        try {
            Load();
            var keys = owners.Keys.Order(StringComparer.Ordinal).ToList();
            var index = 0;
            foreach (var ownerKey in keys) {
                if (index++ % every != 0) continue;
                tally.Owners++;
                // A Traditional owner's actions are not born from text (FLOW_OWNER_KIND): counted apart.
                if (!(ModelSession.Implements(owners[ownerKey], "IMobileScreen") || ModelSession.Implements(owners[ownerKey], "IMobileBlock"))) { tally.Traditional++; continue; }
                foreach (var kind in Kinds) {
                    var owner = owners[ownerKey];
                    var bare = FlowBattery.StableSeed(seed, ownerKey, kind) % 2 == 1;
                    var template = Template(reader, root, owner, kind, bare, tally.Rules, null) ?? Template(reader, root, owner, kind, bare, tally.Rules, session);
                    if (template == null) { if (owner.Children.OfType<IObjectSignature>().Any(c => reader.KindOf(c) == kind)) tally.Skipped++; continue; }
                    var (item, source, name, text, added) = template.Value;
                    tally.Created++; tally.ByKind[kind] = tally.ByKind.GetValueOrDefault(kind) + 1;
                    var where = label + " " + FlowOwners.PathOf(reader, root, owner) + "." + name + " [" + kind + " from " + item.Name + (added.Count > 0 ? ", patched" : "") + "]";
                    JsonObject? receipt = null;
                    var addedReceipts = new List<JsonObject>();
                    var started = clock.Elapsed.TotalMilliseconds;
                    try {
                        session.Mutate("Anvil: flow create battery", () => {
                            // The new client actions of the patch first (the corrected text calls them).
                            foreach (var extra in added) addedReceipts.Add(session.ApplyFlowText(extra));
                            receipt = session.ApplyFlowText(text);
                        });
                    }
                    catch (Exception error) {
                        var coded = Errors.FindCoded(error);
                        tally.Failures.Add(where + " " + (coded?.Code ?? error.GetBaseException().GetType().Name) + ": " + Clip(Errors.Text(error), 900));
                        log?.Invoke("FAIL " + tally.Failures[^1]);
                        Debug(tally.Failures.Count, tally.Failures[^1], text, error.ToString());
                        Load();
                        continue;
                    }
                    finally { tally.ApplyMs += clock.Elapsed.TotalMilliseconds - started; }
                    foreach (var (op, count) in receipt!["ops"]!.AsObject()) tally.Ops[op] = tally.Ops.GetValueOrDefault(op) + count!.GetValue<int>();
                    var why = ReadBack(reader, root, owner, receipt, text, bare);
                    for (var i = 0; i < added.Count && why == null; i++)
                        if (ReadBack(reader, root, null, addedReceipts[i], added[i], true) is { } other) why = "the patch's client action: " + other;
                    if (why == null && verify.Sample() && owner.Children.OfType<IObjectSignature>().FirstOrDefault(c => c.ObjectKey?.ToString() == receipt["key"]!.ToString()) is { } born
                        && verify.Added(born, source) is { Count: > 0 } errors)
                        why = "reads back as the text, and the Verify has more errors under the new action than under " + item.Name + ": " + string.Join("; ", errors.Take(3));
                    if (why == null) { tally.Exact++; tally.ExactByKind[kind] = tally.ExactByKind.GetValueOrDefault(kind) + 1; }
                    else {
                        tally.Failures.Add(where + " " + why);
                        log?.Invoke("FAIL " + tally.Failures[^1]);
                        Debug(tally.Failures.Count, tally.Failures[^1], text, null);
                    }
                }
            }
        } finally { if (espace != null) ModelHost.Release(espace); }
        tally.Verified = verify.Verified; tally.VerifyRefused = verify.Refused;
        return tally;
    }

    // The first action of that kind of the owner (by name, then key) that is a fixed point of its text without opaque nodes
    // and whose text, written new, the owner's rules accept (a new For Each that only filters is refused, T1: counted in
    // rules, and the next one is taken); with the new name and the text. patched: the session the rules' patches take the
    // names of new client actions from; then the first template whose every problem has the certain fix is taken, as the
    // corrected text with the new action texts it adds (counted in rules as "patched CODE").
    private static (FlowItem Item, IObjectSignature Source, string Name, string Text, IReadOnlyList<string> Added)? Template(KernelModelReader reader, IObjectSignature root, IObjectSignature owner, string kind, bool bare,
        SortedDictionary<string, int> rules, ModelSession? patched)
    {
        HashSet<string>? taken = null;
        foreach (var action in owner.Children.OfType<IObjectSignature>().Where(c => reader.KindOf(c) == kind)
                     .OrderBy(reader.DisplayOf, StringComparer.Ordinal).ThenBy(reader.KeyOf, StringComparer.Ordinal)) {
            var item = ModuleFlow.Extract(root, reader, action, out var problems);
            if (problems.Count > 0 || item.Items.Any(i => i.Opaque)) continue;
            var read = ModuleFlow.Print(item);
            if (read.Unprintable.Count > 0 || ModuleFlow.Check(item, read) != null) continue;
            var name = NewName(reader, owner, item.Name);
            // A copy beside its template: a data action output named like an element of the owner (a data action Genres whose output
            // is Genres) collides in the owner's scope, which the Studio refuses by renaming it; such a template is not copied.
            var scope = owner.Children.OfType<IObjectSignature>().Select(reader.DisplayOf).ToHashSet(StringComparer.OrdinalIgnoreCase);
            if (item.Kind == "DataAction" && item.Items.Any(p => p.Role == "out" && scope.Contains(p.Name))) { rules["name of the owner's scope"] = rules.GetValueOrDefault("name of the owner's scope") + 1; continue; }
            var text = Text(read, item, name, bare);
            if (patched == null) {
                var refused = FlowDiff.Compute(null, new Dictionary<string, string>(), ModuleFlow.Read(text)).Problems;
                if (refused.Count > 0) { foreach (var code in refused.Select(p => p.Code).Distinct()) rules[code] = rules.GetValueOrDefault(code) + 1; continue; }
                return (item, action, name, text, []);
            }
            taken ??= patched.ActionScopeNames();
            var fixes = FlowDiff.Compute(null, new Dictionary<string, string>(), ModuleFlow.Read(text), editedText: text, actionTaken: taken.Contains).Problems;
            if (fixes.Count == 0 || fixes.Any(p => p.Corrected == null) || fixes.Select(p => p.Corrected).Distinct().Count() != 1) continue;
            foreach (var code in fixes.Select(p => p.Code).Distinct()) rules["patched " + code] = rules.GetValueOrDefault("patched " + code) + 1;
            return (item, action, name, fixes[0].Corrected!, fixes[0].Added ?? []);
        }
        return null;
    }

    // A name no action of the owner has (without case).
    private static string NewName(KernelModelReader reader, IObjectSignature owner, string name)
    {
        var taken = owner.Children.OfType<IObjectSignature>().Select(reader.DisplayOf).ToHashSet(StringComparer.OrdinalIgnoreCase);
        for (var n = 1; ; n++) if (!taken.Contains(name + "Tx" + n)) return name + "Tx" + n;
    }

    // The read of the template as a new action's text: the header without @key under the new name, every id of the read
    // renamed to an id no read gives (@n4 -> @xn4); bare: the ids nothing points at left out (a jump, a repeated end, a
    // comment attached), as a model writes a new action.
    internal static string Text(FlowDocument read, FlowItem item, string name, bool bare)
    {
        var lines = read.Text.Split('\n').ToList();
        var header = lines.FindIndex(l => !l.StartsWith("///", StringComparison.Ordinal));
        var owner = item.Owner.Length > 0 ? item.Owner + "." : "";
        var head = FlowPrinter.Labels[item.Kind] + " " + owner;
        var line = lines[header];
        line = line[..line.LastIndexOf(" @", StringComparison.Ordinal)];      // the read's @key: a new action has none
        lines[header] = head + name + line[(head.Length + item.Name.Length)..];  // the flags after the name stay
        var text = ReadId.Replace(string.Join("\n", lines), m => "@x" + m.Groups[1].Value);
        if (!bare) return text;
        var pointed = new HashSet<string>(StringComparer.Ordinal);
        foreach (Match jump in Regex.Matches(text, @"(?:-> |//-> )@(x[npl][0-9]+)", RegexOptions.CultureInvariant)) pointed.Add(jump.Groups[1].Value);
        foreach (var end in Regex.Matches(text, @"^\s*end(?:  # .*)? @(x[npl][0-9]+)$", RegexOptions.Multiline | RegexOptions.CultureInvariant).GroupBy(m => m.Groups[1].Value).Where(g => g.Count() > 1))
            pointed.Add(end.Key);
        return Regex.Replace(text, @" @(x[npl][0-9]+)$", m => pointed.Contains(m.Groups[1].Value) ? m.Value : "", RegexOptions.Multiline | RegexOptions.CultureInvariant);
    }

    // Null when the new action reads back as exactly the text (printed with the ids the text gave its elements); else why not.
    // owner: where the action is (null: a module action, found in the module).
    private static string? ReadBack(KernelModelReader reader, IObjectSignature root, IObjectSignature? owner, JsonObject receipt, string text, bool bare)
    {
        var key = receipt["key"]!.ToString();
        var action = (owner?.Children.OfType<IObjectSignature>() ?? reader.ChildrenOf(root)).FirstOrDefault(c => c.ObjectKey?.ToString() == key);
        if (action == null) return "the new action @" + key + " is not under its owner";
        var after = ModuleFlow.Extract(root, reader, action, out var problems);
        if (problems.Count > 0) return "read back with problems: " + string.Join("; ", problems.Take(3));
        var ids = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (id, created) in receipt["keys"]!.AsObject()) ids[created!.ToString()] = id;
        var back = ModuleFlow.Print(after, ids).Text;
        // The header of the read names the new key; the text, written new, has none.
        var lines = back.Split('\n').ToList();
        var header = lines.FindIndex(l => !l.StartsWith("///", StringComparison.Ordinal));
        if (header >= 0 && lines[header].EndsWith(" @" + key, StringComparison.Ordinal)) lines[header] = lines[header][..^(key.Length + 2)];
        back = string.Join("\n", lines);
        if (bare) back = Fresh.Replace(back, "");
        if (back == text) return null;
        return "reads back as other text: " + FirstDifference(text, back);
    }

    // FLOW_BATTERY_DEBUG=<folder>: each failure written there with the text (and the error).
    private static void Debug(int n, string failure, string text, string? error)
    {
        if (Environment.GetEnvironmentVariable("FLOW_BATTERY_DEBUG") is not { Length: > 0 } folder) return;
        Directory.CreateDirectory(folder);
        var label = new string(failure.TakeWhile(c => c != ' ').Where(char.IsLetterOrDigit).ToArray());
        File.WriteAllText(Path.Combine(folder, "create-" + label + "-" + n.ToString("D4") + ".txt"), failure + "\n\n=== text\n" + text + (error != null ? "\n=== error\n" + error + "\n" : ""));
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

    private static string Clip(string text, int max = 300) => text.Length <= max ? text : text[..max] + "…";

    private static bool UnderReference(KernelModelReader reader, IObjectSignature node, IObjectSignature root)
    {
        for (var at = reader.ParentOf(node); at != null && !ReferenceEquals(at, root); at = reader.ParentOf(at))
            if (reader.KindOf(at) == "Reference") return true;
        return false;
    }
}
