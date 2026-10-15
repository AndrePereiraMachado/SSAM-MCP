using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// The battery of the three-way merge of the data text (DdlMerge): on real modules, a Studio edit and a model edit of the same
/// read. The Studio edit is written first (the module now differs from the read); the model's statements, written on the read
/// (basedOn: the read kept in memory as the store keeps it), go through the `spec` op's `ddl` form and are merged; the whole
/// module is then read back and must be the expected text (DdlCheck: every element by key, every property, every value and
/// position), the elements the edit created with the keys the apply gave them.
/// The expected text is the Studio's module text with the model's line edits applied where the model wrote them (the same
/// edit, by key, on the Studio's lines). Cases, on elements the battery creates in the module (an entity, a static entity
/// with records, two structures) and on a real entity or structure of the module:
/// <list type="bullet">
/// <item>disjoint: an attribute added in the Studio while the model changes another one of the same statement (the model's
/// statement does not have the Studio's attribute: it must stay); the reverse; an attribute the model deletes while the Studio
/// adds one; a record added in the Studio while the model changes another record's value; a structure field added in the
/// Studio while the model labels another; an attribute renamed in the Studio while the model labels another (its statement
/// still has the old name); two statements, one per side; a real statement of the module.</item>
/// <item>overlapping: the same label on both sides; an attribute the model deletes that the Studio changed; an attribute the
/// Studio deletes that the model changed (written again, new key); the same record value on both sides; the same attribute
/// renamed on both sides; a structure the model drops that the Studio changed. The conflict must be listed with the
/// element's key and the delivery's side kept.</item>
/// <item>refused (review of the junction feat/texto-ssam-2): a statement written on a read of another module (DDL_BASE_FOREIGN),
/// and one that names by its key an attribute created after the read and changed in the Studio since (DDL_BASE_UNKNOWN): the
/// op must be refused with that code and the module must read as it did before it (nothing compiled as sent).</item>
/// </list>
/// The Studio's edits (and the battery's own setup) are written on the module as it is: basedOn is the capture the session
/// runs on (Now).
/// </summary>
public static class DdlMergeBattery
{
    public sealed class Tally
    {
        public int Modules, Cases, Exact, Disjoint, DisjointExact, Overlap, OverlapExact, Conflicts, Skipped, Refused, RefusedExact;
        public readonly SortedDictionary<string, int> ByCase = new(StringComparer.Ordinal);
        public readonly SortedDictionary<string, int> ExactByCase = new(StringComparer.Ordinal);
        public readonly List<string> Failures = [];
        public double Ms;
        public JsonObject ToJson() => new() {
            ["modules"] = Modules, ["cases"] = Cases, ["exact"] = Exact, ["disjoint"] = Disjoint, ["disjointExact"] = DisjointExact,
            ["overlap"] = Overlap, ["overlapExact"] = OverlapExact, ["refused"] = Refused, ["refusedExact"] = RefusedExact, ["conflictsListed"] = Conflicts, ["skipped"] = Skipped, ["ms"] = Math.Round(Ms),
            ["byCase"] = new JsonObject(ByCase.Select(p => KeyValuePair.Create(p.Key, (JsonNode?)p.Value))),
            ["exactByCase"] = new JsonObject(ExactByCase.Select(p => KeyValuePair.Create(p.Key, (JsonNode?)p.Value))),
            ["failures"] = new JsonArray(Failures.Take(40).Select(f => (JsonNode)f).ToArray()) };
        public void Add(Tally other)
        {
            Modules += other.Modules; Cases += other.Cases; Exact += other.Exact; Disjoint += other.Disjoint; DisjointExact += other.DisjointExact;
            Overlap += other.Overlap; OverlapExact += other.OverlapExact; Conflicts += other.Conflicts; Skipped += other.Skipped; Ms += other.Ms;
            Refused += other.Refused; RefusedExact += other.RefusedExact;
            foreach (var (k, v) in other.ByCase) ByCase[k] = ByCase.GetValueOrDefault(k) + v;
            foreach (var (k, v) in other.ExactByCase) ExactByCase[k] = ExactByCase.GetValueOrDefault(k) + v;
            Failures.AddRange(other.Failures);
        }
    }

    public static readonly string[] DisjointCases = ["add|edit", "edit|add", "add|delete", "record|value", "field|label", "rename|label", "two-statements", "real"];
    public static readonly string[] OverlapCases = ["same-label", "delete|changed", "changed|delete", "same-value", "same-rename", "drop|changed"];
    public static readonly string[] RefusedCases = ["foreign-read", "newer-element"];

    // The basedOn of the edits written on the module as it is (the Studio's, the setup): the capture the session runs on.
    private const string Now = "ddl-merge-battery-now";

    // One case: the Studio's statements and the model's, each made from the read's blocks; the expected blocks from the Studio's.
    private sealed record Plan(string Name, bool Disjoint, string Studio, string Model, Func<DataDdl, DataDdl, string?> Expected, string? Conflict);

    /// <summary>Every case `rounds` times over the module loaded from `oml` (one round = each disjoint and overlapping case once).</summary>
    public static Tally Run(ModelHost host, string oml, string lane, int seed = 1, int rounds = 2, Action<string>? log = null)
    {
        var tally = new Tally { Modules = 1 };
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var label = Path.GetFileNameWithoutExtension(oml);
        var bytes = File.ReadAllBytes(oml);
        var reader = new KernelModelReader();
        var espace = host.Load(bytes);
        var tag = "x" + (seed % 97).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var counter = 0;
        string Fresh(string what) => what + ++counter + tag;
        DataDdl Read() => DataDdl.Build((IObjectSignature)espace, reader, lane, "", 0);
        JsonNode? Apply(string ddl, string? basedOn, string? read)
        {
            var session = basedOn == null ? new ModelSession(espace) { BaseSha256 = Now } : new ModelSession(espace) { DdlReadings = sha => sha == basedOn ? read : null };
            var data = new JsonObject { ["ddl"] = ddl, ["basedOn"] = basedOn ?? Now };
            return session.Apply(new JsonArray(new JsonObject { ["op"] = "spec", ["data"] = data }))[0]?["result"];
        }
        // The battery's own elements (an ODC library without entities of its own takes the static entity and the structures).
        string Names() => "MgE" + tag + ",MgS" + tag + ",MgT" + tag + ",MgD" + tag;
        var entity = "MgE" + tag; var statik = "MgS" + tag; var type = "MgT" + tag; var disposable = "MgD" + tag;
        var setupEntity = "create entity " + entity + " public (\n  Id Long Integer identifier auto required,\n  A1 Text(50),\n  A2 Text(50),\n  A3 Integer default 0,\n  A4 Boolean,\n  A5 Text(20),\n  A6 Text(30),\n  A7 Text(30)\n);";
        var setupRest = "create static entity " + statik + " public (\n  Id Integer identifier required,\n  Label Text(50) required,\n  Order Integer required,\n  Cor Text(20)\n)\nvalues\n"
            + "  R1 (Id = 1, Label = \"Um\", Order = 1, Cor = \"red\"),\n  R2 (Id = 2, Label = \"Dois\", Order = 2, Cor = \"blue\"),\n  R3 (Id = 3, Label = \"Tres\", Order = 3, Cor = \"green\");\n\n"
            + "type " + type + " public = {\n  F1: Text(20);\n  F2: Integer;\n  F3: Boolean;\n  F4: Text(10);\n}";
        var hasEntity = true;
        try {
            try { Apply(setupEntity + "\n\n" + setupRest, null, null); }
            catch (Exception error) {
                log?.Invoke(label + ": no entity of the battery (" + Clip(Errors.Text(error)) + ")");
                ModelHost.Release(espace); espace = host.Load(bytes); hasEntity = false;
                Apply(setupRest, null, null);
            }
            log?.Invoke(label + ": battery elements " + Names() + (hasEntity ? "" : " (no entity: the module keeps none of its own)"));
            for (var round = 0; round < rounds; round++) {
                foreach (var name in DisjointCases.Concat(OverlapCases)) {
                    // The structure the model drops is made anew for each round.
                    if (name == "drop|changed" && !Read().Blocks.Any(b => b.Name == disposable)) Apply("type " + disposable + " = {\n  G1: Integer;\n}", null, null);
                    var @base = Read();
                    var plan = Make(name, @base, lane, entity, statik, type, disposable, hasEntity, Fresh, round, label);
                    if (plan == null) continue;
                    // The Studio's edit (no read: the module as it is).
                    try { Apply(plan.Studio, null, null); }
                    catch (Exception error) {
                        tally.Skipped++;
                        log?.Invoke($"  {label} [{name}] the Studio edit did not apply: {Errors.Text(error)}");
                        ModelHost.Release(espace); espace = host.Load(bytes);
                        try { Apply(hasEntity ? setupEntity + "\n\n" + setupRest : setupRest, null, null); } catch (Exception) { return Done(); }
                        continue;
                    }
                    var theirs = Read();
                    var token = "read-" + (++counter).ToString(System.Globalization.CultureInfo.InvariantCulture);
                    tally.Cases++; tally.ByCase[name] = tally.ByCase.GetValueOrDefault(name) + 1;
                    if (plan.Disjoint) tally.Disjoint++; else tally.Overlap++;
                    string? why = null;
                    JsonNode? result = null;
                    try { result = Apply(plan.Model, token, @base.Text); }
                    catch (Exception error) { why = "the merged statements did not apply: " + Errors.Text(error); }
                    var conflicts = result?["merged"]?["conflicts"] as JsonArray;
                    tally.Conflicts += conflicts?.Count ?? 0;
                    if (why == null && result?["merged"]?["merge"]?.ToString() != "three-way") why = "the statements were not merged: " + result?["merged"]?.ToJsonString();
                    if (why == null && plan.Disjoint && conflicts is { Count: > 0 }) why = "disjoint edits listed conflicts: " + conflicts.ToJsonString();
                    if (why == null && !plan.Disjoint) {
                        if (conflicts is not { Count: > 0 }) why = "overlapping edits listed no conflict";
                        else if (plan.Conflict != null && !conflicts.Any(c => c?["key"]?.ToString() == plan.Conflict)) why = "the conflict of @" + plan.Conflict + " is not listed: " + conflicts.ToJsonString();
                    }
                    if (why == null) {
                        var expectedText = plan.Expected(@base, theirs);
                        if (expectedText == null) why = "no expectation";
                        else {
                            var expected = DdlParser.Parse(expectedText, lane);
                            var keys = result?["keys"] as JsonObject;
                            foreach (var element in expected.All())
                                if (element.Key.Length == 0 && keys?[(element.Parent != null ? element.Parent.Name + "." : "") + element.Name] is JsonValue k) element.Key = k.GetValue<string>();
                            var check = DdlCheck.RunDocument((IObjectSignature)espace, reader, lane, expected);
                            if (!check.FixedPoint)
                                why = "reads back otherwise: " + (check.ParseError ?? string.Join(" | ", check.Mismatches.Take(6).Select(m => $"{m.Kind} {m.Name} @{m.Key} {m.Property}: {m.Expected} != {m.Actual}")));
                        }
                    }
                    if (why == null) {
                        tally.Exact++; tally.ExactByCase[name] = tally.ExactByCase.GetValueOrDefault(name) + 1;
                        if (plan.Disjoint) tally.DisjointExact++; else tally.OverlapExact++;
                        continue;
                    }
                    tally.Failures.Add($"{label} [{name}] {why}");
                    log?.Invoke("FAIL " + tally.Failures[^1]);
                    ModelHost.Release(espace); espace = host.Load(bytes);
                    // The battery's own elements again, on the module loaded anew.
                    try { Apply(hasEntity ? setupEntity + "\n\n" + setupRest : setupRest, null, null); } catch (Exception) { return Done(); }
                }
                foreach (var name in RefusedCases) {
                    var @base = Read();
                    var document = DdlParser.Parse(@base.Text);
                    var owner = document.Elements.FirstOrDefault(x => x.Name == (hasEntity ? entity : type));
                    if (owner == null) continue;
                    var entityLike = hasEntity;
                    List<DdlElement> Members(DdlElement of) => of.Children.Where(c => c.Kind is "EntityAttribute" or "StructureAttribute").ToList();
                    string BlockOf(DataDdl text, string key) => text.Blocks.First(b => b.Key == key).Text;
                    string code, model, read;
                    if (name == "foreign-read") {
                        // The read of another module: this module's read under another module key.
                        code = "DDL_BASE_FOREIGN";
                        read = Regex.Replace(@base.Text, @" key=@\S+", " key=@ForeignModule" + tag);
                        model = string.Join('\n', SetLabel(Lines(BlockOf(@base, owner.Key)), Members(owner)[^1].Key, "Foreign " + round));
                    } else {
                        // An attribute a job created after the read (its key from the receipt), changed in the Studio since; the model
                        // labels it on the read it had before it existed.
                        code = "DDL_BASE_UNKNOWN";
                        var added = Fresh("Nw");
                        JsonNode? created;
                        try { created = Apply(string.Join('\n', AddMember(Lines(BlockOf(@base, owner.Key)), Members(owner)[^1].Key, entityLike ? "  " + added + " Integer" : "  " + added + ": Integer;", entityLike)), null, null); }
                        catch (Exception error) { tally.Skipped++; log?.Invoke($"  {label} [{name}] the attribute was not created: {Errors.Text(error)}"); continue; }
                        var newKey = created?["keys"]?[owner.Name + "." + added]?.ToString();
                        if (newKey == null) { tally.Skipped++; continue; }
                        var afterCreate = Read();
                        var withIt = BlockOf(afterCreate, owner.Key);
                        var line = Lines(withIt).First(l => l.EndsWith(" -- @" + newKey, StringComparison.Ordinal));
                        var bare = Regex.Replace(line, @"[,;]? -- @\S+$", "");
                        var changed = entityLike ? bare.Replace(" Integer", " Integer default 3") : bare.Replace(": Integer", ": Integer json \"nw\"");
                        try { Apply(withIt.Replace(line, line.Replace(bare, changed)), null, null); }
                        catch (Exception error) { tally.Skipped++; log?.Invoke($"  {label} [{name}] the Studio edit did not apply: {Errors.Text(error)}"); continue; }
                        read = @base.Text;
                        model = string.Join('\n', SetLabel(Lines(withIt), newKey, "Newer " + round));
                    }
                    var before = Read().Text;
                    var token = "read-" + (++counter).ToString(System.Globalization.CultureInfo.InvariantCulture);
                    tally.Cases++; tally.Refused++; tally.ByCase[name] = tally.ByCase.GetValueOrDefault(name) + 1;
                    string? why = null;
                    try { Apply(model, token, read); why = "the statements were applied, not refused (" + code + ")"; }
                    catch (Exception error) {
                        var coded = Errors.FindCoded(error);
                        if (coded?.Code != code) why = "refused otherwise than " + code + ": " + Clip(Errors.Text(error));
                    }
                    if (why == null && Read().Text != before) why = "the module changed although the statements were refused";
                    if (why == null) { tally.Exact++; tally.RefusedExact++; tally.ExactByCase[name] = tally.ExactByCase.GetValueOrDefault(name) + 1; continue; }
                    tally.Failures.Add($"{label} [{name}] {why}");
                    log?.Invoke("FAIL " + tally.Failures[^1]);
                    ModelHost.Release(espace); espace = host.Load(bytes);
                    try { Apply(hasEntity ? setupEntity + "\n\n" + setupRest : setupRest, null, null); } catch (Exception) { return Done(); }
                }
            }
        }
        finally { ModelHost.Release(espace); }
        return Done();
        Tally Done() { tally.Ms = clock.Elapsed.TotalMilliseconds; return tally; }
    }

    /// <summary>Every capture of this lane a manifest lists ([{label, lane, oml}]): the battery on each (a missing one is listed).</summary>
    public static (Tally Total, JsonArray Modules) RunManifest(ModelHost host, string manifest, string lane, int seed, int rounds, Action<string>? log = null, string? only = null)
    {
        var total = new Tally();
        var modules = new JsonArray();
        foreach (var entry in JsonNode.Parse(File.ReadAllText(manifest))!.AsArray()) {
            if (entry!["lane"]?.ToString() != lane) continue;
            var label = entry["label"]?.ToString() ?? "";
            if (only != null && !label.Contains(only, StringComparison.OrdinalIgnoreCase)) continue;
            var oml = entry["oml"]!.ToString();
            if (!File.Exists(oml)) { modules.Add(new JsonObject { ["label"] = label, ["missing"] = oml }); continue; }
            var one = Run(host, oml, lane, seed, rounds, log);
            log?.Invoke($"ddl merge battery {label}: {one.Exact} of {one.Cases} cases exact (disjoint {one.DisjointExact}/{one.Disjoint}, overlapping {one.OverlapExact}/{one.Overlap}), {Math.Round(one.Ms)} ms");
            var json = one.ToJson(); json["label"] = label;
            modules.Add(json);
            total.Add(one);
        }
        return (total, modules);
    }

    // ---- the cases ------------------------------------------------------------------------------------------------------------

    private static Plan? Make(string name, DataDdl @base, string lane, string entity, string statik, string type, string disposable, bool hasEntity,
        Func<string, string> fresh, int round, string label)
    {
        var document = DdlParser.Parse(@base.Text);
        DdlElement? Top(string n) => document.Elements.FirstOrDefault(e => e.Name == n);
        string Block(DdlElement e) => @base.Blocks.First(b => b.Key == e.Key).Text;
        var e = hasEntity ? Top(entity) : null; var s = Top(statik); var t = Top(type);
        DdlElement? Member(DdlElement? owner, string n) => owner?.Children.FirstOrDefault(c => c.Name == n || c.Name.StartsWith(n + "r", StringComparison.Ordinal));
        string? Key(DdlElement? owner, string n) => Member(owner, n)?.Key;
        List<DdlElement> Members(DdlElement owner) => owner.Children.Where(c => c.Kind is "EntityAttribute" or "StructureAttribute").ToList();
        List<DdlElement> Records(DdlElement owner) => owner.Children.Where(c => c.Kind is "Record" or "StaticEntityRecord").ToList();
        // The model's line edits of one block, applied to the read's block (the statement it sends) and to the Studio's block
        // (the expected one, by the same keys).
        Func<DataDdl, DataDdl, string?> Same(params (DdlElement Owner, Func<List<string>, List<string>> Edit)[] edits) => (read, theirs) => {
            var text = theirs.Text;
            foreach (var (owner, edit) in edits) {
                var studio = theirs.Blocks.FirstOrDefault(b => b.Key == owner.Key);
                if (studio == null) return null;
                text = text.Replace(studio.Text, string.Join('\n', edit(Lines(studio.Text))));
            }
            return text;
        };
        string Edited(DdlElement owner, Func<List<string>, List<string>> edit) => string.Join('\n', edit(Lines(Block(owner))));
        var k = round;   // labels differ per round
        switch (name) {
            case "add|edit" when e != null: {
                var last = Members(e)[^1].Key; var a1 = Key(e, "A1")!;
                var added = fresh("St");
                return new(name, true, Edited(e, l => AddMember(l, last, "  " + added + " Integer default 1", true)),
                    Edited(e, l => SetLabel(l, a1, "Model " + k)), Same((e, l => SetLabel(l, a1, "Model " + k))), null);
            }
            case "edit|add" when e != null: {
                var last = Members(e)[^1].Key; var a2 = Key(e, "A2")!;
                var added = fresh("Md");
                return new(name, true, Edited(e, l => Length(l, a2, 3)),
                    Edited(e, l => AddMember(l, last, "  " + added + " Text(40)", true)), Same((e, l => AddMember(l, last, "  " + added + " Text(40)", true))), null);
            }
            case "add|delete" when e != null: {
                // The model deletes an attribute the battery added (St/Md of an earlier case), never one of the setup.
                var gone = Members(e).LastOrDefault(m => Regex.IsMatch(m.Name, "^(St|Md)[0-9]+x"));
                if (gone == null) return null;
                var last = Members(e)[^1].Key;
                var added = fresh("St");
                return new(name, true, Edited(e, l => AddMember(l, last, "  " + added + " Boolean", true)),
                    Edited(e, l => DeleteMember(l, gone.Key, true)), Same((e, l => DeleteMember(l, gone.Key, true))), null);
            }
            case "record|value" when s != null: {
                var records = Records(s); var r1 = records.First(r => r.Name == "R1").Key;
                var id = records.Count + 10 + k * 7;
                var added = fresh("Rs");
                var value = "\"red " + k + "!\"";
                return new(name, true, Edited(s, l => AddRecord(l, records[^1].Key, "  " + added + " (Id = " + id + ", Label = \"" + added + "\", Order = " + id + ", Cor = \"x\")")),
                    Edited(s, l => RecordValue(l, r1, "Cor", value)), Same((s, l => RecordValue(l, r1, "Cor", value))), null);
            }
            case "field|label" when t != null: {
                var last = Members(t)[^1].Key; var f1 = Key(t, "F1")!;
                var added = fresh("Sf");
                return new(name, true, Edited(t, l => AddMember(l, last, "  " + added + ": Integer;", false)),
                    Edited(t, l => SetLabel(l, f1, "Field " + k)), Same((t, l => SetLabel(l, f1, "Field " + k))), null);
            }
            case "rename|label" when e != null: {
                var a3 = Key(e, "A3")!; var a4 = Key(e, "A4")!;
                return new(name, true, Edited(e, l => Rename(l, a3, "A3r" + fresh("s"))),
                    Edited(e, l => SetLabel(l, a4, "Four " + k)), Same((e, l => SetLabel(l, a4, "Four " + k))), null);
            }
            case "two-statements" when t != null && (e ?? s) is { } other: {
                var target = other == e ? Key(e, "A5")! : Records(s!).First().Key;
                var f2 = Key(t, "F2")!;
                var studio = other == e ? Edited(e!, l => SetLabel(l, target, "Five " + k)) : Edited(s!, l => RecordValue(l, target, "Cor", "\"two " + k + "\""));
                return new(name, true, studio, Edited(t, l => SetLabel(l, f2, "Two " + k)), Same((t, l => SetLabel(l, f2, "Two " + k))), null);
            }
            case "real": {
                // A statement of the module itself (an entity or structure with plain members), never one of the battery's.
                var real = document.Elements.FirstOrDefault(x => x.Kind is "ServerEntity" or "Structure" && !x.Name.StartsWith("Mg", StringComparison.Ordinal)
                    && DdlRules.IsBareName(x.Name) && Members(x).Count >= 2 && Members(x).All(m => DdlRules.IsBareName(m.Name) && m.Key.Length > 0)
                    && Block(x).Split('\n').Count(l => l.Contains(" -- @")) == x.Children.Count + 1 && !Block(x).Contains(" index ") && !Block(x).Contains("$\""));
                if (real == null) return null;
                var entityLike = real.Kind != "Structure";
                var last = Members(real)[^1].Key; var labelled = Members(real).Last(m => m.Key != Members(real)[0].Key || Members(real).Count == 1).Key;
                var added = fresh("Sr");
                return new(name, true, Edited(real, l => AddMember(l, last, entityLike ? "  " + added + " Integer default 0" : "  " + added + ": Integer;", entityLike)),
                    Edited(real, l => SetLabel(l, labelled, "Real " + k)), Same((real, l => SetLabel(l, labelled, "Real " + k))), null);
            }
            case "same-label" when e != null: {
                var a1 = Key(e, "A1")!;
                return new(name, false, Edited(e, l => SetLabel(l, a1, "Studio " + k)), Edited(e, l => SetLabel(l, a1, "Delivery " + k)),
                    Same((e, l => SetLabel(l, a1, "Delivery " + k))), a1);
            }
            case "delete|changed" when e != null: {
                var gone = Members(e).LastOrDefault(m => Regex.IsMatch(m.Name, "^(St|Md)[0-9]+x"));
                if (gone == null) return null;
                return new(name, false, Edited(e, l => SetLabel(l, gone.Key, "Changed " + k)), Edited(e, l => DeleteMember(l, gone.Key, true)),
                    Same((e, l => DeleteMember(l, gone.Key, true))), gone.Key);
            }
            case "changed|delete" when e != null: {
                var gone = Members(e).LastOrDefault(m => Regex.IsMatch(m.Name, "^(St|Md)[0-9]+x"));
                if (gone == null) return null;
                var members = Members(e);
                var before = members[members.FindIndex(m => m.Key == gone.Key) - 1].Key;
                var model = Edited(e, l => SetLabel(l, gone.Key, "Kept " + k));
                var line = Lines(model).First(x => x.EndsWith(" -- @" + gone.Key, StringComparison.Ordinal));
                var bare = Regex.Replace(line, @",? -- @\S+$", "");
                // Written again where the model has it, without its key (the Studio removed it: a new element).
                return new(name, false, Edited(e, l => DeleteMember(l, gone.Key, true)), model, Same((e, l => AddMember(l, before, bare, true))), gone.Key);
            }
            case "same-value" when s != null: {
                var r2 = Records(s).First(r => r.Name == "R2").Key;
                return new(name, false, Edited(s, l => RecordValue(l, r2, "Cor", "\"studio " + k + "\"")), Edited(s, l => RecordValue(l, r2, "Cor", "\"delivery " + k + "\"")),
                    Same((s, l => RecordValue(l, r2, "Cor", "\"delivery " + k + "\""))), r2);
            }
            case "same-rename" when e != null: {
                var a5 = Key(e, "A5")!;
                var mine = "A5r" + fresh("d");
                return new(name, false, Edited(e, l => Rename(l, a5, "A5r" + fresh("s"))), Edited(e, l => Rename(l, a5, mine)),
                    Same((e, l => Rename(l, a5, mine))), a5);
            }
            case "drop|changed" when t != null: {
                // A structure of its own, made for this case: changed in the Studio, dropped by the model.
                var d = document.Elements.FirstOrDefault(x => x.Name == disposable);
                if (d == null) return null;
                var gone = d.Key;
                return new(name, false, Edited(d, l => AddMember(l, Members(d)[^1].Key, "  G" + fresh("g") + ": Boolean;", false)),
                    "drop type " + disposable + "; -- @" + gone,
                    (read, theirs) => theirs.Blocks.FirstOrDefault(b => b.Key == gone) is { } block ? theirs.Text.Replace("\n" + block.Text + "\n", "") : null, gone);
            }
        }
        return null;
    }

    private static string Clip(string text) => text.Length <= 300 ? text : text[..300] + "…";

    // ---- line edits (the data text's own lines, by key) ---------------------------------------------------------------------------

    private static readonly Regex KeyTail = new(@" -- @\S+$", RegexOptions.CultureInvariant);

    private static List<string> Lines(string block) => block.Split('\n').ToList();
    private static int At(List<string> lines, string key) => lines.FindIndex(l => l.EndsWith(" -- @" + key, StringComparison.Ordinal));

    // The member lines of an entity or structure statement (after its header, up to ')' or '}').
    private static List<int> MemberLines(List<string> lines)
    {
        var start = lines.FindIndex(l => !l.StartsWith("///", StringComparison.Ordinal));
        var result = new List<int>();
        for (var i = start + 1; i < lines.Count; i++) {
            if (lines[i].StartsWith(')') || lines[i].StartsWith('}')) break;
            if (lines[i].StartsWith("  ", StringComparison.Ordinal) && !lines[i].StartsWith("  ///", StringComparison.Ordinal)) result.Add(i);
        }
        return result;
    }

    private static List<int> RecordLines(List<string> lines)
    {
        var values = lines.FindIndex(l => l == "values");
        if (values < 0) return [];
        var result = new List<int>();
        for (var i = values + 1; i < lines.Count && lines[i].StartsWith("  ", StringComparison.Ordinal); i++)
            if (!lines[i].StartsWith("  ///", StringComparison.Ordinal)) result.Add(i);
        return result;
    }

    private static (string Body, string Key) Split(string line)
    {
        var key = KeyTail.Match(line);
        return key.Success ? (line[..key.Index], key.Value) : (line, "");
    }

    // The separators of an entity's attributes (a comma after each but the last) and of its records (',' then ';').
    private static List<string> Separators(List<string> lines, bool entity)
    {
        if (entity) {
            var members = MemberLines(lines);
            for (var i = 0; i < members.Count; i++) {
                var (body, key) = Split(lines[members[i]]);
                lines[members[i]] = body.TrimEnd(',') + (i < members.Count - 1 ? "," : "") + key;
            }
        }
        var records = RecordLines(lines);
        for (var i = 0; i < records.Count; i++) {
            var (body, key) = Split(lines[records[i]]);
            lines[records[i]] = body.TrimEnd(',', ';') + (i < records.Count - 1 ? "," : ";") + key;
        }
        return lines;
    }

    private static List<string> AddMember(List<string> lines, string after, string line, bool entity)
    {
        var at = At(lines, after);
        lines.Insert(at < 0 ? MemberLines(lines)[^1] + 1 : at + 1, line);
        return Separators(lines, entity);
    }

    private static List<string> DeleteMember(List<string> lines, string key, bool entity)
    {
        var at = At(lines, key);
        if (at < 0) return lines;
        var first = at;
        while (first > 0 && lines[first - 1].StartsWith("  ///", StringComparison.Ordinal)) first--;
        lines.RemoveRange(first, at - first + 1);
        return Separators(lines, entity);
    }

    private static List<string> AddRecord(List<string> lines, string after, string line)
    {
        lines.Insert(At(lines, after) + 1, line);
        return Separators(lines, false);
    }

    // A label clause on a member line (replaced when it has one; before the default, else at the end of its clauses).
    private static List<string> SetLabel(List<string> lines, string key, string label)
    {
        var at = At(lines, key);
        if (at < 0) return lines;
        var (body, tail) = Split(lines[at]);
        var separator = body.EndsWith(',') || body.EndsWith(';') ? body[^1..] : "";
        if (separator.Length > 0) body = body[..^1];
        var clause = " label \"" + label + "\"";
        if (Regex.IsMatch(body, @" label (""(?:[^""]|"""")*""|none)")) body = Regex.Replace(body, @" label (""(?:[^""]|"""")*""|none)", clause.Replace("$", "$$"));
        else {
            var cut = body.IndexOf(" default ", StringComparison.Ordinal);
            body = cut >= 0 ? body[..cut] + clause + body[cut..] : body + clause;
        }
        lines[at] = body + separator + tail;
        return lines;
    }

    private static List<string> Length(List<string> lines, string key, int delta)
    {
        var at = At(lines, key);
        if (at >= 0) lines[at] = Regex.Replace(lines[at], @"Text\((\d+)\)", m => "Text(" + (int.Parse(m.Groups[1].Value) + delta) + ")");
        return lines;
    }

    private static List<string> Rename(List<string> lines, string key, string name)
    {
        var at = At(lines, key);
        if (at >= 0) lines[at] = Regex.Replace(lines[at], @"^  [^ :]+", "  " + name);
        return lines;
    }

    private static List<string> RecordValue(List<string> lines, string key, string attribute, string value)
    {
        var at = At(lines, key);
        if (at >= 0) lines[at] = Regex.Replace(lines[at], @"(?<=[( ])" + Regex.Escape(attribute) + @" = (""(?:[^""]|"""")*""|[^,)]+)", attribute + " = " + value.Replace("$", "$$"));
        return lines;
    }
}
