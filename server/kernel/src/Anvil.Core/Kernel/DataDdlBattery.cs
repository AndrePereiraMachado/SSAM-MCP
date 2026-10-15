using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;
using OutSystems.Model;

namespace Anvil.Core;

// The battery of DL2 (the way back of the data text): edits of a module's own data text, made the way a model edits it (the
// statements that change, as read, changed), applied to the loaded module through the `spec` op's `ddl` form, then the whole
// module read back: the module must be a fixed point of the edited text (every element, by key, every property: DdlCheck),
// with the elements the edit created under the keys the apply gave them. So an edit comes back equal, and no key changes
// outside it. Deterministic: the same module and seed give the same edits.
public sealed class DdlBattery
{
    // The basedOn of an edit written on the module as it is: the capture the session runs on (statements with keys need one).
    private const string Now = "ddl-battery-now";

    public sealed record Edit(string Kind, string Target);
    public sealed record Failure(string Module, int Batch, string Edits, string Error);

    public int Edits { get; private set; }
    public int Batches { get; private set; }
    public int Exact { get; private set; }
    public SortedDictionary<string, int> ByKind { get; } = new(StringComparer.Ordinal);
    public List<Failure> Failures { get; } = [];
    public long Milliseconds { get; private set; }

    public JsonObject ToJson() => new() {
        ["edits"] = Edits, ["exact"] = Exact, ["batches"] = Batches, ["ms"] = Milliseconds,
        ["byKind"] = JsonNode.Parse(System.Text.Json.JsonSerializer.Serialize(ByKind)),
        ["failures"] = new JsonArray(Failures.Take(40).Select(f => (JsonNode)new JsonObject { ["module"] = f.Module, ["batch"] = f.Batch, ["edits"] = f.Edits, ["error"] = f.Error }).ToArray()) };

    // Runs `target` edits (in batches of at most `perBatch`, one per statement) on the module loaded from `oml`.
    public static DdlBattery Run(ModelHost host, string oml, string lane, int target, int seed, int perBatch = 8, Action<string>? log = null)
    {
        var battery = new DdlBattery();
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var espace = host.Load(File.ReadAllBytes(oml));
        var label = Path.GetFileNameWithoutExtension(oml);
        try {
            var generator = new DdlEditGenerator(lane, seed);
            var reader = new KernelModelReader();
            while (battery.Edits < target && battery.Batches < target * 2) {
                battery.Batches++;
                var current = DataDdl.Build((IObjectSignature)espace, reader, lane, "", 0);
                var batch = generator.Next(current, perBatch);
                if (batch.Edits.Count == 0) break;
                var description = string.Join("; ", batch.Edits.Select(e => e.Kind + " " + e.Target));
                JsonNode? result;
                try {
                    var session = new ModelSession(espace) { BaseSha256 = Now };
                    var results = session.Apply(new JsonArray(new JsonObject { ["op"] = "spec", ["data"] = new JsonObject { ["ddl"] = batch.Text, ["basedOn"] = Now } }));
                    result = results[0]?["result"];
                }
                catch (Exception ex) {
                    battery.Failures.Add(new Failure(label, battery.Batches, description, Errors.Text(ex)));
                    log?.Invoke($"  {label} batch {battery.Batches} refused: {Errors.Text(ex)}");
                    // The failed transaction leaves nothing; the module is loaded again so the next batch starts clean.
                    ModelHost.Release(espace);
                    espace = host.Load(File.ReadAllBytes(oml));
                    battery.Count(batch.Edits, exact: false);
                    continue;
                }
                // The edited text, the new elements with the keys the apply gave them: the module must read back as it. What the
                // edit renames is read in the other statements as the platform rewrites it (types, Entities.X.Y, Site.X).
                var expected = DdlParser.Parse(batch.Expected(current), lane);
                var before = DdlParser.Parse(current.Text);
                DdlCompiler.ImplicitReferences(expected, before);
                DdlCompiler.Canonical(expected, DdlCompiler.RenamesOf(DdlParser.Parse(batch.Text, lane), before), lane);
                var keys = result?["keys"] as JsonObject;
                foreach (var element in expected.All())
                    if (element.Key.Length == 0 && !element.Drop && keys?[(element.Parent != null ? element.Parent.Name + "." : "") + element.Name] is JsonValue k)
                        element.Key = k.GetValue<string>();
                var check = DdlCheck.RunDocument((IObjectSignature)espace, reader, lane, expected);
                generator.Created(keys);
                var exact = check.FixedPoint;
                battery.Count(batch.Edits, exact);
                if (!exact) {
                    var details = string.Join(" | ", check.Mismatches.Take(8).Select(m => $"{m.Kind} {m.Name} @{m.Key} {m.Property}: {m.Expected} != {m.Actual}"));
                    battery.Failures.Add(new Failure(label, battery.Batches, description, details));
                    log?.Invoke($"  {label} batch {battery.Batches} differs: {details}");
                }
            }
        }
        finally { ModelHost.Release(espace); }
        battery.Milliseconds = clock.ElapsedMilliseconds;
        return battery;
    }

    // One edit of a module's text, applied to the module loaded from `oml`: the ops it compiles to, the result of the op, and
    // the module's text after it (the proofs of the tests: a rename is only a rename and keeps the key).
    public static JsonObject Apply(ModelHost host, string oml, string lane, Func<string, string> edit)
    {
        var espace = host.Load(File.ReadAllBytes(oml));
        try {
            var reader = new KernelModelReader();
            var before = DataDdl.Build((IObjectSignature)espace, reader, lane, "", 0).Text;
            var text = edit(before);
            var compiled = DdlCompiler.Compile(DdlParser.Parse(text, lane), DdlParser.Parse(before), lane, "$ddl", text);
            var ops = new JsonArray(compiled.Ops().Select(o => (JsonNode)o.Op.DeepClone()).ToArray());
            var problems = new JsonArray(compiled.Problems.Select(p => (JsonNode)(p.Code + " line " + p.Line + ": " + p.Message)).ToArray());
            JsonNode? result = null; string? error = null;
            try { result = new ModelSession(espace) { BaseSha256 = Now }.Apply(new JsonArray(new JsonObject { ["op"] = "spec", ["data"] = new JsonObject { ["ddl"] = text, ["basedOn"] = Now } }))[0]?["result"]?.DeepClone(); }
            catch (Exception ex) { error = Errors.Text(ex); }
            var after = DataDdl.Build((IObjectSignature)espace, reader, lane, "", 0).Text;
            return new JsonObject { ["before"] = before, ["text"] = text, ["ops"] = ops, ["problems"] = problems, ["result"] = result, ["error"] = error, ["after"] = after };
        }
        finally { ModelHost.Release(espace); }
    }

    // The fixed point of a text over a module loaded from `oml`, the elements without a key given the keys an apply answered
    // (the `keys` of the spec op's result, by "<Parent>.<Name>" or "<Name>").
    public static DdlCheck Check(ModelHost host, string oml, string lane, string text, JsonObject? keys)
    {
        var document = DdlParser.Parse(text, lane);
        foreach (var element in document.All())
            if (element.Key.Length == 0 && keys?[(element.Parent != null ? element.Parent.Name + "." : "") + element.Name] is JsonValue k) element.Key = k.GetValue<string>();
        return CheckDocument(host, oml, lane, document);
    }

    // The fixed point of a document already read (the whole module's text, every element with its key) over a module loaded
    // from `oml`.
    public static DdlCheck CheckDocument(ModelHost host, string oml, string lane, DdlDocument document)
    {
        var espace = host.Load(File.ReadAllBytes(oml));
        try { return DdlCheck.RunDocument((IObjectSignature)espace, new KernelModelReader(), lane, document); }
        finally { ModelHost.Release(espace); }
    }

    // Every capture of this lane a manifest lists ([{label, lane, oml}], the corpus of the plan): `perModule` edits each (or a
    // number from the module's size when 0), one seed per module. A missing capture is listed, never an error.
    public static (DdlBattery Total, JsonArray Modules) RunManifest(ModelHost host, string manifest, string lane, int perModule, int seed, Action<string>? log = null, string? only = null)
    {
        var total = new DdlBattery();
        var modules = new JsonArray();
        foreach (var entry in JsonNode.Parse(File.ReadAllText(manifest))!.AsArray()) {
            if (entry!["lane"]?.ToString() != lane) continue;
            var label = entry["label"]?.ToString() ?? "";
            if (only != null && !label.Contains(only, StringComparison.OrdinalIgnoreCase)) continue;
            var oml = entry["oml"]!.ToString();
            if (!File.Exists(oml)) { modules.Add(new JsonObject { ["label"] = label, ["missing"] = oml }); continue; }
            var target = perModule > 0 ? perModule : Target(host, oml, lane);
            var one = Run(host, oml, lane, target, seed + Seed(label), log: log);
            log?.Invoke($"ddl battery {label}: {one.Exact} of {one.Edits} edits back equal, {one.Batches} batches, {one.Milliseconds} ms");
            var json = one.ToJson(); json["label"] = label;
            modules.Add(json);
            total.Add(one);
        }
        return (total, modules);
    }

    // The edits of a module: 32, and one more per 40 data elements, up to 64.
    private static int Target(ModelHost host, string oml, string lane) => Math.Clamp(32 + host.BuildDdl(File.ReadAllBytes(oml), "", lane).Elements / 40, 32, 64);

    private static int Seed(string label) => label.Aggregate(17, (h, c) => unchecked(h * 31 + c)) & 0x7fff;

    private void Count(List<Edit> edits, bool exact)
    {
        Edits += edits.Count;
        if (exact) Exact += edits.Count;
        foreach (var edit in edits) ByKind[edit.Kind] = ByKind.GetValueOrDefault(edit.Kind) + 1;
    }

    public void Add(DdlBattery other)
    {
        Edits += other.Edits; Exact += other.Exact; Batches += other.Batches; Milliseconds += other.Milliseconds;
        foreach (var (kind, count) in other.ByKind) ByKind[kind] = ByKind.GetValueOrDefault(kind) + count;
        Failures.AddRange(other.Failures);
    }
}

// The edits, made on the text as a model makes them: whole statements, as read, with lines changed, added or removed.
public sealed class DdlEditGenerator(string lane, int seed)
{
    public sealed class Batch
    {
        public List<DdlBattery.Edit> Edits { get; } = [];
        // The statements sent back: the edited blocks, the new ones and the drops.
        public List<(string? Key, string Text)> Blocks { get; } = [];
        // Elements the edit makes anew under their old key (an index given other columns): the module gives them a new key.
        public HashSet<string> Rekeyed { get; } = new(StringComparer.Ordinal);
        public string Text => string.Join("\n\n", Blocks.Select(b => b.Text));

        // The whole module text after the edit: each edited block in place of its own, the new ones added, the dropped ones out.
        public string Expected(DataDdl current)
        {
            var replaced = Blocks.Where(b => b.Key != null).GroupBy(b => b.Key!).ToDictionary(g => g.Key, g => g.Last().Text, StringComparer.Ordinal);
            var dropped = new HashSet<string>(Blocks.Where(b => b.Text.StartsWith("drop ", StringComparison.Ordinal) && b.Text.Contains(" -- @"))
                .Select(b => b.Text[(b.Text.LastIndexOf(" -- @", StringComparison.Ordinal) + 5)..].Trim()), StringComparer.Ordinal);
            var blocks = current.Blocks.Where(b => !dropped.Contains(b.Key)).Select(b => replaced.TryGetValue(b.Key, out var text) && !text.StartsWith("drop ", StringComparison.Ordinal) ? text : b.Text);
            var added = Blocks.Where(b => b.Key == null && !b.Text.StartsWith("drop ", StringComparison.Ordinal)).Select(b => b.Text);
            // A dropped index lives in its entity's block: the block without its line.
            var lines = string.Join("\n\n", blocks.Concat(added)).Split('\n').Where(l => !dropped.Any(k => l.EndsWith(" -- @" + k, StringComparison.Ordinal) && l.StartsWith("create ", StringComparison.Ordinal) && l.Contains(" index ")))
                .Select(l => Rekeyed.Any(k => l.EndsWith(" -- @" + k, StringComparison.Ordinal)) ? l[..l.LastIndexOf(" -- @", StringComparison.Ordinal)] : l);
            return string.Join('\n', lines);
        }
    }

    private readonly Random random = new(seed);
    private readonly HashSet<string> created = new(StringComparer.Ordinal);
    private int fresh;

    // The keys of what the last batch created: those elements may be deleted later (they have no consumers).
    public void Created(JsonObject? keys)
    {
        if (keys == null) return;
        foreach (var (_, key) in keys) if (key is JsonValue v) created.Add(v.GetValue<string>());
    }

    private string Fresh(string what) => "Bt" + what + ++fresh + "x" + seed % 97;

    public Batch Next(DataDdl current, int size)
    {
        var batch = new Batch();
        var document = DdlParser.Parse(current.Text);
        var byKey = document.Elements.Where(e => e.Key.Length > 0).GroupBy(e => e.Key).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        var blocks = current.Blocks.Where(b => byKey.ContainsKey(b.Key)).OrderBy(_ => random.Next()).ToList();
        var used = new HashSet<string>(StringComparer.Ordinal);
        // New statements: about one in four edits.
        var additions = Math.Max(1, size / 4);
        for (var i = 0; i < additions && batch.Edits.Count < size; i++) AddNew(batch, document);
        foreach (var block in blocks) {
            if (batch.Edits.Count >= size) break;
            if (!used.Add(block.Key)) continue;
            var element = byKey[block.Key];
            // The battery's own top-level elements are sometimes dropped (they have no consumers).
            if (created.Contains(element.Key) && random.Next(4) == 0) {
                batch.Blocks.Add((element.Key, "drop " + Words(element) + " " + DdlRules.Name(element.Name) + "; -- @" + element.Key));
                batch.Edits.Add(new("drop " + Words(element), element.Name));
                continue;
            }
            for (var attempt = 0; attempt < 6; attempt++) {
                var kinds = Kinds(element);
                var kind = kinds[random.Next(kinds.Length)];
                var edited = Apply(kind, block.Text, element, document, out var target);
                if (edited == null || edited == block.Text) continue;
                if (kind == "index columns" && rekeyed != null) batch.Rekeyed.Add(rekeyed);
                batch.Blocks.Add((block.Key, edited));
                batch.Edits.Add(new(kind, target ?? element.Name));
                break;
            }
        }
        // A dropped index of the battery's own: its own statement.
        foreach (var index in document.All().Where(e => e.Kind == "EntityIndex" && created.Contains(e.Key) && e.Parent != null && !used.Contains(e.Parent.Key)).Take(1)) {
            if (batch.Edits.Count >= size || random.Next(3) != 0) break;
            batch.Blocks.Add((null, "drop index " + DdlRules.Name(index.Name) + "; -- @" + index.Key));
            batch.Edits.Add(new("drop index", index.Name));
            used.Add(index.Parent!.Key);
        }
        return batch;
    }

    private static string[] Kinds(DdlElement element) => element.Kind switch {
        "ServerEntity" or "ClientEntity" => ["rename entity", "description", "add attribute", "rename attribute", "attribute description", "length", "required", "default",
            "label", "swap attributes", "delete rule", "update", "public", "delete attribute", "type", "decimals", "index unique", "index columns", "rename index", "add index"],
        "StaticEntity" => ["rename entity", "description", "add attribute", "rename attribute", "attribute description", "length", "add record", "rename record",
            "record value", "delete record", "label", "public", "swap attributes", "delete attribute"],
        "Structure" => ["rename type", "description", "add attribute", "rename attribute", "attribute description", "length", "required", "default", "label", "json",
            "swap attributes", "public", "delete attribute", "type", "decimals"],
        "Timer" => ["rename declaration", "description", "timeout"],
        _ => ["rename declaration", "description", "default value"] };

    // ---- new statements ------------------------------------------------------------------------------------------------------

    private void AddNew(Batch batch, DdlDocument document)
    {
        // A new entity references one of the module's own (never one the battery may drop in the same batch).
        var entities = document.Elements.Where(e => e.Kind == "ServerEntity" && DdlRules.IsBareName(e.Name) && !created.Contains(e.Key)).ToList();
        // A module with no entity of its own (an ODC library keeps only static ones) takes a static entity instead.
        var choice = random.Next(5);
        if (choice == 0 && !document.Elements.Any(e => e.Kind == "ServerEntity")) choice = 1;
        switch (choice) {
            case 0: {
                var name = Fresh("E");
                var reference = entities.Count > 0 && random.Next(2) == 0 ? entities[random.Next(entities.Count)].Name : null;
                var text = "/// Battery entity " + name + ".\ncreate entity " + name + (random.Next(2) == 0 ? " public" : "") + " (\n"
                    + "  Id Long Integer identifier auto required,\n  Nome Text(80) required,\n  Valor Integer default 0" + (reference != null ? ",\n  Ref" + reference + " " + reference + " Identifier references " + reference + " on delete Ignore" : "")
                    + "\n);\ncreate unique index " + Fresh("I") + " on " + name + " (Nome);";
                batch.Blocks.Add((null, text)); batch.Edits.Add(new("new entity", name));
                break;
            }
            case 1: {
                var name = Fresh("S");
                var text = "create static entity " + name + " public (\n  Id Integer identifier required,\n  Label Text(50) required,\n  Order Integer required,\n  Cor Text(20)\n)\nvalues\n"
                    + "  " + Fresh("R") + " (Id = 1, Label = \"Um\", Order = 1, Cor = \"red\"),\n  " + Fresh("R") + " (Id = 2, Label = \"Dois\", Order = 2);";
                batch.Blocks.Add((null, text)); batch.Edits.Add(new("new static entity", name));
                break;
            }
            case 2: {
                var name = Fresh("T");
                var text = "/// Battery type.\ntype " + name + (random.Next(2) == 0 ? " public" : "") + " = {\n  Codigo: Text(20) required;\n  Qtd: Integer default 1;\n  Preco: Decimal(18,4) json \"preco\";\n}";
                batch.Blocks.Add((null, text)); batch.Edits.Add(new("new type", name));
                break;
            }
            case var site when site == 3 || !document.Elements.Any(e => e.Kind == "ClientVariable"): {
                // A module without client variables (a service module) takes none.
                var name = Fresh("P");
                batch.Blocks.Add((null, (lane == "odc" ? "setting " : "site property ") + name + ": Integer = 5")); batch.Edits.Add(new("new site property", name));
                break;
            }
            default: {
                var name = Fresh("C");
                batch.Blocks.Add((null, "/// Battery variable.\nclient variable " + name + ": Text = \"x\"")); batch.Edits.Add(new("new client variable", name));
                break;
            }
        }
    }

    // ---- edits of a statement --------------------------------------------------------------------------------------------------

    private static readonly Regex KeyTail = new(@" -- @\S+$", RegexOptions.Compiled);

    private string? rekeyed;

    private string? Apply(string kind, string text, DdlElement element, DdlDocument document, out string? target)
    {
        target = null; rekeyed = null;
        var lines = text.Split('\n').ToList();
        var header = lines.FindIndex(l => !l.StartsWith("///", StringComparison.Ordinal));
        var members = Members(lines, element);
        string? Pick(Func<int, bool> filter, out int at)
        {
            var candidates = members.Where(filter).ToList();
            at = candidates.Count == 0 ? -1 : candidates[random.Next(candidates.Count)];
            return at < 0 ? null : MemberName(lines[at]);
        }
        switch (kind) {
            case "rename entity" or "rename type" or "rename declaration": {
                var old = element.Name;
                if (!DdlRules.IsBareName(old)) return null;
                var name = Fresh("N");
                var word = new Regex(@"(?<![\w\]])" + Regex.Escape(old) + @"(?![\w\[])");
                lines[header] = word.Replace(lines[header], name, 1);
                // The statements of the entity name it too (its indexes, events and sample record).
                for (var i = header + 1; i < lines.Count; i++)
                    if (lines[i].StartsWith("create ", StringComparison.Ordinal) && lines[i].Contains(" index ") || lines[i].StartsWith("on ", StringComparison.Ordinal) || lines[i].StartsWith("sample ", StringComparison.Ordinal))
                        lines[i] = Regex.Replace(lines[i], @"(?<=( on | create | update | delete |^sample ))" + Regex.Escape(old) + @"(?=[ (])", name);
                target = old + " -> " + name;
                break;
            }
            case "description": {
                if (header > 0) {
                    if (random.Next(2) == 0) lines.RemoveRange(0, header);
                    else lines[0] += " (edited)";
                }
                else lines.Insert(0, "/// Edited by the battery.");
                break;
            }
            case "attribute description": {
                if (Pick(_ => true, out var at) is not { } name) return null;
                if (at > 0 && lines[at - 1].StartsWith("  ///", StringComparison.Ordinal)) {
                    if (random.Next(2) == 0) { var first = at - 1; while (first > 0 && lines[first - 1].StartsWith("  ///", StringComparison.Ordinal)) first--; lines.RemoveRange(first, at - first); }
                    else lines[at - 1] += " (edited)";
                }
                else lines.Insert(at, "  /// What " + name + " holds.");
                target = name;
                break;
            }
            case "add attribute": {
                var name = Fresh("A");
                var type = random.Next(4) switch { 0 => "Text(50)", 1 => "Integer default 0", 2 => "Boolean", _ => "Decimal(18,2)" };
                if (element.Kind == "Structure") lines.Insert(lines.FindIndex(l => l.StartsWith('}')), "  " + name + ": " + type + ";");
                else {
                    var last = members.Count > 0 ? members[^1] : -1;
                    if (last < 0) return null;
                    lines[last] = Comma(lines[last], true);
                    lines.Insert(last + 1, "  " + name + " " + type);
                }
                target = name;
                break;
            }
            case "delete attribute": {
                // Only an attribute of the battery's own that nothing in the statement names (records, indexes, label/order/active).
                if (Pick(i => KeyOf(lines[i]) is { } k && created.Contains(k) && !lines[i].Contains(" identifier") && MemberName(lines[i]) is { } candidate
                        && !lines.Any(l => l != lines[i] && System.Text.RegularExpressions.Regex.IsMatch(l, @"(?<![\w\]])" + System.Text.RegularExpressions.Regex.Escape(candidate) + @"(?![\w\[])")
                            && (Record(l) || l.Contains(" index ") || l.StartsWith("sample ", StringComparison.Ordinal) || !l.StartsWith("  ", StringComparison.Ordinal))), out var at) is not { } name) return null;
                var last = at == members[^1];
                var first = at; while (first > 0 && lines[first - 1].StartsWith("  ///", StringComparison.Ordinal)) first--;
                lines.RemoveRange(first, at - first + 1);
                if (last && element.Kind != "Structure") {
                    var previous = Members(lines, element);
                    if (previous.Count == 0) return null;
                    lines[previous[^1]] = Comma(lines[previous[^1]], false);
                }
                target = name;
                break;
            }
            case "rename attribute": {
                if (Pick(i => DdlRules.IsBareName(MemberName(lines[i]) ?? "["), out var at) is not { } old) return null;
                var name = Fresh("M");
                lines[at] = "  " + name + lines[at][(2 + old.Length)..];
                // The statement names the attribute elsewhere too: label/order/active, index columns, record values.
                var word = @"(?<![\w\]])" + Regex.Escape(old) + @"(?![\w\[])";
                lines[header] = Regex.Replace(lines[header], @"(?<= (label|order|active) )" + Regex.Escape(old) + @"(?= )", name);
                for (var i = 0; i < lines.Count; i++) {
                    if (i == at) continue;
                    if (lines[i].StartsWith("create ", StringComparison.Ordinal) && lines[i].Contains(" index "))
                        lines[i] = Regex.Replace(lines[i], @"\(([^)]*)\)", m => "(" + Regex.Replace(m.Groups[1].Value, word, name) + ")");
                    else if (Record(lines[i]) || lines[i].StartsWith("sample ", StringComparison.Ordinal))
                        lines[i] = Regex.Replace(lines[i], @"(?<=[(,] )" + Regex.Escape(old) + @"(?= = )|(?<=\()" + Regex.Escape(old) + @"(?= = )", name);
                }
                target = old + " -> " + name;
                break;
            }
            case "length": {
                if (Pick(i => Regex.IsMatch(lines[i], @"[ :]Text\(\d+\)"), out var at) is not { } name) return null;
                lines[at] = Regex.Replace(lines[at], @"Text\((\d+)\)", m => "Text(" + (long.Parse(m.Groups[1].Value) + 7) + ")", RegexOptions.None);
                target = name;
                break;
            }
            case "decimals": {
                if (Pick(i => Regex.IsMatch(lines[i], @"Decimal\(\d+,\d\)"), out var at) is not { } name) return null;
                lines[at] = Regex.Replace(lines[at], @"Decimal\((\d+),(\d)\)", m => "Decimal(" + m.Groups[1].Value + "," + (int.Parse(m.Groups[2].Value) is var d && d >= 6 ? d - 1 : d + 1) + ")");
                target = name;
                break;
            }
            case "required": {
                if (Pick(i => !lines[i].Contains(" identifier") && !lines[i].Contains(" default $"), out var at) is not { } name) return null;
                lines[at] = Regex.IsMatch(Clauses(lines[at]), @" required\b") ? RemoveClause(lines[at], @" required\b") : InsertClause(lines[at], " required");
                target = name;
                break;
            }
            case "default": {
                if (Pick(i => SimpleType(lines[i]) != null && !lines[i].Contains(" identifier"), out var at) is not { } name) return null;
                var type = SimpleType(lines[at])!;
                var value = type switch { "Integer" => random.Next(100).ToString(), "Boolean" => random.Next(2) == 0 ? "True" : "False", "Decimal" => "1.5", _ => "\"v" + random.Next(100) + "\"" };
                lines[at] = Clauses(lines[at]).Contains(" default ") && random.Next(3) == 0 ? RemoveDefault(lines[at]) : InsertClause(RemoveDefault(lines[at]), " default " + value);
                target = name;
                break;
            }
            case "label": {
                if (Pick(i => !lines[i].Contains(" default $"), out var at) is not { } name) return null;
                lines[at] = Clauses(lines[at]).Contains(" label ") ? Regex.Replace(lines[at], @" label (""(?:[^""]|"""")*""|none)", " label \"Label " + random.Next(100) + "\"")
                    : InsertClause(lines[at], " label \"Label " + random.Next(100) + "\"");
                target = name;
                break;
            }
            case "json": {
                if (Pick(i => !lines[i].Contains(" default $"), out var at) is not { } name) return null;
                lines[at] = Clauses(lines[at]).Contains(" json ") ? Regex.Replace(lines[at], @" json (""(?:[^""]|"""")*"")", " json \"j" + random.Next(100) + "\"")
                    : InsertClause(lines[at], " json \"j" + random.Next(100) + "\"");
                target = name;
                break;
            }
            case "swap attributes": {
                if (members.Count < 2) return null;
                var i = random.Next(members.Count - 1);
                var (a, b) = (Unit(lines, members[i]), Unit(lines, members[i + 1]));
                var first = lines.GetRange(a.Start, a.End - a.Start + 1); var second = lines.GetRange(b.Start, b.End - b.Start + 1);
                lines.RemoveRange(a.Start, b.End - a.Start + 1);
                lines.InsertRange(a.Start, second.Concat(first));
                if (element.Kind != "Structure") {
                    var now = Members(lines, element);
                    for (var k = 0; k < now.Count; k++) lines[now[k]] = Comma(lines[now[k]], k < now.Count - 1);
                }
                target = MemberName(lines[members[i]]);
                break;
            }
            case "delete rule": {
                if (Pick(i => Regex.IsMatch(lines[i], @" on delete (Protect|Ignore)\b"), out var at) is not { } name) return null;
                if (element.Kind == "StaticEntity") return null;
                lines[at] = Regex.Replace(lines[at], @" on delete (Protect|Ignore)\b", m => " on delete " + (m.Groups[1].Value == "Protect" ? "Ignore" : "Protect"));
                target = name;
                break;
            }
            case "update": {
                if (element.Kind != "ServerEntity") return null;
                lines[header] = lines[header].Contains(" update full") ? lines[header].Replace(" update full", "") : Regex.Replace(lines[header], @"^(create entity (\[[^\]]*\]|\S+)( public)?)", "$1 update full");
                break;
            }
            case "public": {
                lines[header] = Regex.IsMatch(lines[header], @"^(create (\w+ )*entity|type) (\[[^\]]*\]|\S+) public\b")
                    ? Regex.Replace(lines[header], @"^((create (\w+ )*entity|type) (\[[^\]]*\]|\S+)) public\b", "$1")
                    : Regex.Replace(lines[header], @"^((create (\w+ )*entity|type) (\[[^\]]*\]|\S+))", "$1 public");
                break;
            }
            case "type": {
                if (Pick(i => KeyOf(lines[i]) is { } k && created.Contains(k) && Regex.IsMatch(lines[i], @"[ :]Text\(\d+\)") && !Clauses(lines[i]).Contains(" default "), out var at) is not { } name) return null;
                lines[at] = Regex.Replace(lines[at], @"Text\(\d+\)", "Integer");
                target = name;
                break;
            }
            case "add index": {
                var name = Fresh("I");
                var columns = members.Select(m => MemberName(lines[m])).Where(n => n != null && DdlRules.IsBareName(n) && !lines[members.First(x => MemberName(lines[x]) == n)].Contains(" identifier"))
                    .OrderBy(_ => random.Next()).Take(1 + random.Next(2)).ToList();
                if (columns.Count == 0 || element.Kind != "ServerEntity" || !DdlRules.IsBareName(element.Name)) return null;
                if (lines.Any(l => l.Contains(" index ") && l.Contains("(" + string.Join(", ", columns) + ")"))) return null;
                lines.Add("create index " + name + " on " + element.Name + " (" + string.Join(", ", columns) + ");");
                target = name;
                break;
            }
            case "index unique" or "index columns" or "rename index": {
                var at = lines.FindIndex(l => l.StartsWith("create ", StringComparison.Ordinal) && l.Contains(" index ") && KeyOf(l) is { } k && created.Contains(k));
                if (at < 0) return null;
                if (kind == "index unique") lines[at] = lines[at].StartsWith("create unique ", StringComparison.Ordinal) ? lines[at].Replace("create unique index", "create index") : lines[at].Replace("create index", "create unique index");
                else if (kind == "rename index") lines[at] = Regex.Replace(lines[at], @"(?<=index )\S+", Fresh("I"));
                else {
                    var columns = members.Select(m => MemberName(lines[m])).Where(n => n != null && DdlRules.IsBareName(n) && n != "Id").ToList();
                    if (columns.Count < 2) return null;
                    var chosen = "(" + string.Join(", ", columns.OrderBy(_ => random.Next()).Take(2)) + ")";
                    if (lines.Any(l => l.Contains(" index ") && l.Contains(chosen))) return null;
                    lines[at] = Regex.Replace(lines[at], @"\(([^)]*)\)", chosen);
                    rekeyed = KeyOf(lines[at]);
                }
                target = Regex.Match(lines[at], @"(?<=index )\S+").Value;
                break;
            }
            case "add record": {
                if (!element.Children.Any(c => c.Kind == "EntityAttribute" && c.Name == "Id" && c.Props.GetValueOrDefault("DataType") is "Integer" or "Long Integer")) return null;
                var name = Fresh("R");
                var existing = element.Children.Where(c => c.Kind is "Record" or "StaticEntityRecord").ToList();
                var ids = existing.Select(r => r.Values.FirstOrDefault(v => v.Attribute == "Id").Value).Select(v => long.TryParse(v, out var n) ? n : 0).DefaultIfEmpty(0).Max() + 1;
                var attributes = element.Children.Where(c => c.Kind == "EntityAttribute").ToList();
                var parts = new List<string> { "Id = " + ids };
                if (attributes.Any(c => c.Name == "Label")) parts.Add("Label = \"" + name + "\"");
                if (attributes.Any(c => c.Name == "Order")) parts.Add("Order = " + ids);
                // Every value the platform keeps for a record, written as a model writes a whole record: the label and order
                // attributes the entity names (`label Caption`) and each required one, as the last record has it (or its
                // default). A record without them is not one the platform keeps (DdlConventions fills or refuses it).
                var context = new DdlParsedContext(element);
                var written = new HashSet<string>(StringComparer.Ordinal) { "Id", "Label", "Order" };
                foreach (var (property, value) in new[] { ("LabelAttribute", "\"" + name + "\""), ("OrderByAttribute", ids.ToString(System.Globalization.CultureInfo.InvariantCulture)) })
                    if (context.Value(property) is { } role && attributes.Any(a => a.Name == role) && written.Add(role)) parts.Add(DdlRules.Name(role) + " = " + value);
                foreach (var attribute in attributes.Where(a => a.Props.GetValueOrDefault("IsMandatory") == "True" && a.Props.GetValueOrDefault("IsAutoNumber") is not ("Yes" or "True") && !written.Contains(a.Name))) {
                    var value = existing.Count > 0 ? existing[^1].Values.FirstOrDefault(v => v.Attribute == attribute.Name).Value : null;
                    value ??= attribute.Props.GetValueOrDefault("DefaultValue");
                    if (value == null) return null;
                    parts.Add(DdlRules.Name(attribute.Name) + " = " + DdlRules.Expression(value, DdlStop.Item));
                }
                var values = string.Join(", ", parts);
                var records = Enumerable.Range(0, lines.Count).Where(i => Record(lines[i])).ToList();
                if (records.Count == 0) {
                    var close = lines.FindIndex(l => l == ");");
                    if (close < 0) return null;
                    lines[close] = ")";
                    lines.InsertRange(close + 1, ["values", "  " + name + " (" + values + ");"]);
                }
                else {
                    lines[records[^1]] = Regex.Replace(lines[records[^1]], @";( -- @\S+)$", ",$1");
                    lines.Insert(records[^1] + 1, "  " + name + " (" + values + ");");
                }
                target = name;
                break;
            }
            case "delete record": {
                var records = Enumerable.Range(0, lines.Count).Where(i => Record(lines[i])).ToList();
                var mine = records.Where(i => KeyOf(lines[i]) is { } k && created.Contains(k)).ToList();
                if (mine.Count == 0 || records.Count < 2) return null;
                var at = mine[random.Next(mine.Count)];
                target = Regex.Match(lines[at], @"^  (\S+)").Groups[1].Value;
                var last = at == records[^1];
                lines.RemoveAt(at);
                if (last) lines[records[^2]] = Regex.Replace(lines[records[^2]], @",( -- @\S+)$", ";$1");
                break;
            }
            case "rename record": {
                var records = Enumerable.Range(0, lines.Count).Where(i => Record(lines[i]) && Regex.IsMatch(lines[i], @"^  [A-Za-z_]\w* \(")).ToList();
                if (records.Count == 0) return null;
                var at = records[random.Next(records.Count)];
                var old = Regex.Match(lines[at], @"^  (\S+)").Groups[1].Value;
                lines[at] = "  " + Fresh("Q") + lines[at][(2 + old.Length)..];
                target = old;
                break;
            }
            case "record value": {
                var records = Enumerable.Range(0, lines.Count).Where(i => Record(lines[i]) && Regex.IsMatch(lines[i], @"= ""[^""]*""")).ToList();
                if (records.Count == 0) return null;
                var at = records[random.Next(records.Count)];
                lines[at] = Regex.Replace(lines[at], @"(= ""[^""]*)""", "$1!\"", RegexOptions.None);
                target = Regex.Match(lines[at], @"^  (\S+)").Groups[1].Value;
                break;
            }
            case "timeout": {
                lines[header] = Regex.IsMatch(lines[header], @" timeout \d+") ? Regex.Replace(lines[header], @" timeout (\d+)", m => " timeout " + (int.Parse(m.Groups[1].Value) + 1))
                    : KeyTail.Replace(lines[header], m => " timeout 7" + m.Value, 1);
                break;
            }
            case "default value": {
                if (element.Props.GetValueOrDefault("DataType") is not ("Integer" or "Text" or "Boolean") || element.Props.GetValueOrDefault("IsReadOnly") == "True") return null;
                var value = element.Props["DataType"] switch { "Integer" => random.Next(100).ToString(), "Boolean" => random.Next(2) == 0 ? "True" : "False", _ => "\"d" + random.Next(100) + "\"" };
                var line = Regex.Replace(lines[header], @" = .*(?= -- @\S+$)", "");
                lines[header] = KeyTail.Replace(line, m => " = " + value + m.Value, 1);
                break;
            }
            default: return null;
        }
        return string.Join('\n', lines);
    }

    // ---- lines ---------------------------------------------------------------------------------------------------------------

    // The attribute lines of an entity or structure statement (indented, keyed, not a description), in order.
    private static List<int> Members(List<string> lines, DdlElement element)
    {
        var start = lines.FindIndex(l => !l.StartsWith("///", StringComparison.Ordinal));
        var result = new List<int>();
        for (var i = start + 1; i < lines.Count; i++) {
            var line = lines[i];
            if (line.StartsWith(')') || line.StartsWith('}')) break;
            if (!line.StartsWith("  ", StringComparison.Ordinal) || line.StartsWith("  ///", StringComparison.Ordinal)) continue;
            result.Add(i);
        }
        return result;
    }

    private static (int Start, int End) Unit(List<string> lines, int at)
    {
        var start = at;
        while (start > 0 && lines[start - 1].StartsWith("  ///", StringComparison.Ordinal)) start--;
        return (start, at);
    }

    private static bool Record(string line) => line.StartsWith("  ", StringComparison.Ordinal) && !line.StartsWith("  ///", StringComparison.Ordinal) && Regex.IsMatch(line, @"^  (\S+|\[[^\]]*\]) \(.*\)( os:\S+)*[,;]( -- @\S+)?$");

    private static string? MemberName(string line)
    {
        var m = Regex.Match(line, @"^  (\[(?:[^\]]|\]\])*\]|[^ :]+)");
        return m.Success ? m.Groups[1].Value : null;
    }

    private static string? KeyOf(string line) => Regex.Match(line, @" -- @(\S+)$") is { Success: true } m ? m.Groups[1].Value : null;

    // The clauses of a member line: after the name, before the separator and the key.
    private static string Clauses(string line) => Regex.Replace(KeyTail.Replace(line, ""), @"[,;]$", "");

    // An entity attribute line with or without its separating comma.
    private static string Comma(string line, bool with)
    {
        var key = KeyTail.Match(line);
        var body = key.Success ? line[..key.Index] : line;
        body = body.TrimEnd(',');
        return body + (with ? "," : "") + (key.Success ? key.Value : "");
    }

    // A clause inserted before the default (the last clause) or at the end of the clauses.
    private static string InsertClause(string line, string clause)
    {
        var key = KeyTail.Match(line);
        var body = key.Success ? line[..key.Index] : line;
        var separator = body.EndsWith(',') || body.EndsWith(';') ? body[^1..] : "";
        if (separator.Length > 0) body = body[..^1];
        var at = body.IndexOf(" default ", StringComparison.Ordinal);
        body = at >= 0 ? body[..at] + clause + body[at..] : body + clause;
        return body + separator + (key.Success ? key.Value : "");
    }

    private static string RemoveClause(string line, string pattern)
    {
        var key = KeyTail.Match(line);
        var body = key.Success ? line[..key.Index] : line;
        var at = body.IndexOf(" default ", StringComparison.Ordinal);
        var head = at >= 0 ? body[..at] : body; var tail = at >= 0 ? body[at..] : "";
        return new Regex(pattern).Replace(head, "", 1) + tail + (key.Success ? key.Value : "");
    }

    private static string RemoveDefault(string line)
    {
        var key = KeyTail.Match(line);
        var body = key.Success ? line[..key.Index] : line;
        var separator = body.EndsWith(',') || body.EndsWith(';') ? body[^1..] : "";
        if (separator.Length > 0) body = body[..^1];
        var at = body.IndexOf(" default ", StringComparison.Ordinal);
        if (at >= 0) body = body[..at];
        return body + separator + (key.Success ? key.Value : "");
    }

    // The type of a member line when it is one a battery default fits (Integer, Boolean, Decimal, Text).
    private static string? SimpleType(string line)
    {
        var m = Regex.Match(line, @"^  (?:\[(?:[^\]]|\]\])*\]|[^ :]+):? (Integer|Boolean|Decimal|Text)(\(|[ ,;]|$)");
        return m.Success ? m.Groups[1].Value : null;
    }

    private string Words(DdlElement element) => element.Kind switch {
        "Structure" => "type", "SiteProperty" => lane == "odc" ? "setting" : "site property", "ClientVariable" => "client variable",
        "SessionVariable" => "session variable", "Timer" => "timer", _ => DdlRules.EntityWords(element.Kind) + "entity" };
}
