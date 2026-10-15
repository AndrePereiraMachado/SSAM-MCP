using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Core;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

// Linked into both test projects. What the platform fills by itself for a static entity (DdlConventions) on the real modules
// of the plan's corpus (kernel/tests/text-corpus/unique.json; skipped with a notice when the captures are not on this
// machine), through the whole job (JobRunner: preflight, apply, Verify, data contract), accepted on the first call:
//   - job A, on the capture: new static entities generated from one of its own of each shape (AutoNumber identifier, Integer,
//     Text; the copy as read; without the Order attribute; without the Label, Id or Order values; the identifier without
//     `required`; a unique index on the identifier), and those real ones edited as read with their identifier, label and
//     order values left out and a new record that writes none of them;
//   - job B, on job A's candidate: the copy of the first one edited by key, its Order attribute left out and a required
//     attribute with a default added.
// Each must be accepted (Verify without new errors, data contract kept), the candidate must read back as the text with the
// platform's fill (DdlCheck, the fixed point of the way back), and the values themselves are the ones the rule names (next
// free id, the record's name, its position, the default, what the module had). The session of 2026-10-12 (jobs #15, #16,
// #19 of VisitaCerta_CS) is accepted on the first call too (O11).
public sealed class DdlConventionsNativeTests(ITestOutputHelper output)
{
    private static (string Lane, string Kernel) Lane()
    {
        var odc = typeof(ModelHost).Assembly.GetType("Anvil.Core.StudioAssembliesOdc");
        var kernel = Path.GetDirectoryName(typeof(DdlConventionsNativeTests).Assembly.Location)!;
        while (!File.Exists(Path.Combine(kernel, "MANIFESTO.md"))) kernel = Directory.GetParent(kernel)!.FullName;
        return (odc != null ? "odc" : "o11", kernel);
    }

    private static void Bind()
    {
        var assembly = typeof(ModelHost).Assembly;
        var binder = assembly.GetType("Anvil.Core.StudioAssembliesOdc") ?? assembly.GetType("Anvil.Core.StudioAssemblies")!;
        var bind = binder.GetMethods().First(m => m.Name == "Bind");
        bind.Invoke(null, bind.GetParameters().Select(p => p.HasDefaultValue ? p.DefaultValue : null).ToArray());
    }

    private static string Sha(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    // ---- the generated cases on the corpus -----------------------------------------------------------------------------------

    private sealed record Source(DdlElement Element, string Block, string? Identifier, string? Label, string? Order, bool Auto);
    private sealed record Case(string Entity, string Variant, Source Source);

    [Fact]
    public void GeneratedStaticEntityCasesOfTheCorpusAreAcceptedFirstAndMeanWhatThePlatformFills()
    {
        var (lane, kernel) = Lane();
        var entries = JsonNode.Parse(File.ReadAllText(Path.Combine(kernel, "tests", "text-corpus", "unique.json")))!.AsArray()
            .Where(e => e!["lane"]!.ToString() == lane && File.Exists(e["oml"]!.ToString())).Select(e => e!).ToList();
        if (entries.Count == 0) { output.WriteLine("SKIPPED: the text corpus of the " + lane + " lane is not on this machine"); return; }
        Bind();
        var work = Path.Combine(kernel, ".local", lane == "odc" ? "lane-odc" : "", "conventions-tests");
        Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        int modules = 0, cases = 0, jobs = 0;
        var notes = new SortedDictionary<string, int>(StringComparer.Ordinal);
        foreach (var entry in entries) {
            var label = entry["label"]!.ToString();
            var oml = entry["oml"]!.ToString();
            var bytes = File.ReadAllBytes(oml);
            var read = host.BuildDdl(bytes, "", lane);
            // One static entity of each shape the module has (an AutoNumber identifier of O11 before the rule, an Integer one, a
            // Text one), then the next ones, up to three.
            var fair = Sources(read).ToList();
            var sources = fair.GroupBy(s => s.Auto ? "auto" : s.Identifier != null ? "integer" : "other").Select(g => g.First()).ToList();
            sources = sources.Concat(fair.Where(s => !sources.Contains(s))).Take(3).ToList();
            if (sources.Count == 0) continue;
            modules++;
            // Job A: the new static entities and the two real ones edited.
            var generated = new List<Case>();
            var texts = new List<string>();
            for (var j = 0; j < sources.Count; j++)
                foreach (var (variant, text) in NewVariants(sources[j], "Fx" + j)) { texts.Add(text); generated.Add(new(Name(text), variant, sources[j])); }
            for (var j = 0; j < sources.Count; j++) {
                var (text, added) = Kept(sources[j], "FxNew" + j);
                texts.Add(text);
                generated.Add(new(sources[j].Element.Name, "kept:" + added, sources[j]));
            }
            var ddlA = string.Join("\n\n", texts);
            var (resultA, candidateA) = Run(host, work, label + "-A", oml, bytes, ddlA, lane);
            jobs++;
            Count(notes, resultA);
            var afterA = Accepted(host, candidateA, read, ddlA, resultA, lane, label + " job A");
            foreach (var c in generated) {
                Means(afterA, read, c, label);
                cases++;
            }
            // Job B, on job A's candidate: the first copy edited by key (its Order left out, a required attribute added).
            var copy = generated.First(c => c.Variant == "copy");
            var candidateBytes = File.ReadAllBytes(candidateA);
            var readA = host.BuildDdl(candidateBytes, "", lane);
            var block = readA.Blocks.First(b => b.Name == copy.Entity).Text;
            // The same statement written from memory (its Order left out, no `order none`) while the records have Order values:
            // refused once with the patch (the line as read), and the patch is accepted on the first call, the values kept.
            var copyRead = DdlParser.Parse(readA.Text).Elements.First(e => e.Name == copy.Entity);
            if (copy.Source.Order == "Order" && !copy.Source.Element.Props.ContainsKey("OrderByAttribute") && Records(copyRead).Any(r => Value(r, "Order") != null)) {
                var memory = KeptEdit(block, copy.Source, orderNone: false);
                var refused = DdlConventions.Apply(DdlParser.Parse(memory, lane), DdlParser.Parse(readA.Text));
                var problem = Assert.Single(refused.Problems, p => p.Code == "DDL_STATIC_ATTRIBUTE_LEFT_OUT");
                Assert.NotNull(problem.Corrected);
                var (resultP, candidateP) = Run(host, work, label + "-P", candidateA, candidateBytes, problem.Corrected!, lane);
                jobs++;
                var afterP = Accepted(host, candidateP, readA, problem.Corrected!, resultP, lane, label + " job P (the patch)");
                var kept = Records(afterP.Elements.First(e => e.Name == copy.Entity)).ToDictionary(r => r.Name, StringComparer.Ordinal);
                Assert.All(Records(copyRead), r => Assert.Equal(Value(r, "Order"), Value(kept[r.Name], "Order")));
                cases++;
            }
            var ddlB = KeptEdit(block, copy.Source);
            var (resultB, candidateB) = Run(host, work, label + "-B", candidateA, candidateBytes, ddlB, lane);
            jobs++;
            Count(notes, resultB);
            var afterB = Accepted(host, candidateB, readA, ddlB, resultB, lane, label + " job B");
            var edited = afterB.Elements.First(e => e.Name == copy.Entity);
            if (copy.Source.Order == "Order") Assert.DoesNotContain(edited.Children, a => a.Kind == "EntityAttribute" && a.Name == "Order");
            Assert.All(Records(edited), r => Assert.Equal("7", Value(r, "FxPeso")));
            cases++;
            output.WriteLine($"{label}: {generated.Count + 1} cases accepted first ({sources.Count} static entities: {string.Join(", ", sources.Select(s => s.Element.Name + " " + Records(s.Element).Count + " records" + (s.Auto ? " auto" : "")))})");
        }
        output.WriteLine($"{lane}: {modules} modules, {cases} cases, {jobs} jobs, all accepted on the first call; notes {JsonSerializer.Serialize(notes)}");
        Assert.True(modules > 0, "no module of the corpus has a static entity");
        Assert.True(notes.ContainsKey("DDL_STATIC_VALUE_FILLED") && notes.ContainsKey("DDL_STATIC_VALUE_KEPT") && notes.ContainsKey("DDL_IDENTIFIER_REQUIRED") && notes.ContainsKey("DDL_STATIC_INDEX_DROPPED"));
    }

    // Static entities of a module that make a fair source: a bare name, up to 40 records, nothing written as os: on a record.
    private static IEnumerable<Source> Sources(DataDdl read)
    {
        var document = DdlParser.Parse(read.Text);
        foreach (var entity in document.Elements.Where(e => e.Kind == "StaticEntity" && DdlRules.IsBareName(e.Name) && e.Name.Length <= 40)) {
            var records = Records(entity);
            if (records.Count is 0 or > 40 || records.Any(r => r.Props.Count > 0 || !DdlRules.IsBareName(r.Name))) continue;
            if (read.Blocks.FirstOrDefault(b => b.Key == entity.Key) is not { } block) continue;
            var attributes = entity.Children.Where(c => c.Kind == "EntityAttribute").ToList();
            if (attributes.Any(a => !DdlRules.IsBareName(a.Name))) continue;
            var context = new DdlParsedContext(entity);
            string? Of(string? name, Func<string?, bool> type) => attributes.FirstOrDefault(a => a.Name == name) is { } a && type(a.Props.GetValueOrDefault("DataType")) ? a.Name : null;
            var identifier = Of(entity.Props.GetValueOrDefault("Identifier"), t => t is "Integer" or "Long Integer");
            var auto = identifier != null && attributes.First(a => a.Name == identifier).Props.GetValueOrDefault("IsAutoNumber") is "Yes" or "True";
            yield return new(entity, block.Text, identifier, Of(context.Value("LabelAttribute"), t => t is null or "Text"), Of(context.Value("OrderByAttribute"), t => t is "Integer" or "Long Integer"), auto);
        }
    }

    private static List<DdlElement> Records(DdlElement entity) => entity.Children.Where(c => c.Kind is "Record" or "StaticEntityRecord").ToList();
    private static string? Value(DdlElement record, string attribute) => record.Values.FirstOrDefault(v => v.Attribute == attribute).Value;
    private static string Name(string statement) => Regex.Match(statement, @"(?m)^create static entity (\S+)").Groups[1].Value;

    // ---- the texts ------------------------------------------------------------------------------------------------------------

    // The statement's lines: the head (descriptions, header and attributes up to its ')'), then the records.
    private static (List<string> Head, List<DdlElement> Records) Split(string block, DdlElement entity)
    {
        var lines = block.Replace("\r\n", "\n").Split('\n').ToList();
        var close = lines.FindIndex(l => l.StartsWith(')'));
        return (lines.Take(close + 1).Select(l => l.StartsWith(')') ? ")" : l).ToList(), Records(entity));
    }

    private static string RecordLine(DdlElement record, IEnumerable<(string Attribute, string Value)> values, bool last, bool keep) =>
        "  " + DdlRules.Name(record.Name) + " (" + string.Join(", ", values.Select(v => DdlRules.Name(v.Attribute) + " = " + DdlRules.Expression(v.Value, DdlStop.Item))) + ")"
        + (last ? ";" : ",") + (keep && record.Key.Length > 0 ? " -- @" + record.Key : "");

    private static string Statement(List<string> head, IEnumerable<string> records) => string.Join('\n', head) + "\nvalues\n" + string.Join('\n', records);

    private static readonly Regex KeyTail = new(@" -- @\S+$", RegexOptions.Compiled);

    // An attribute line with or without the comma that separates it from the next one.
    private static string Comma(string line, bool with)
    {
        var key = KeyTail.Match(line);
        var body = (key.Success ? line[..key.Index] : line).TrimEnd(',');
        return body + (with ? "," : "") + (key.Success ? key.Value : "");
    }

    // The head without an attribute's line (and its description), the commas fixed.
    private static List<string> WithoutAttribute(List<string> head, string attribute)
    {
        var lines = new List<string>(head);
        var at = lines.FindIndex(l => l.StartsWith("  " + attribute + " ", StringComparison.Ordinal));
        if (at < 0) return lines;
        var first = at; while (first > 0 && lines[first - 1].StartsWith("  ///", StringComparison.Ordinal)) first--;
        lines.RemoveRange(first, at - first + 1);
        var members = Enumerable.Range(0, lines.Count).Where(i => lines[i].StartsWith("  ", StringComparison.Ordinal) && !lines[i].StartsWith("  ///", StringComparison.Ordinal)).ToList();
        if (members.Count > 0) lines[members[^1]] = Comma(lines[members[^1]], false);
        return lines;
    }

    // The new static entities of one source, each under its own name: (variant, statement).
    private static IEnumerable<(string Variant, string Text)> NewVariants(Source source, string tag)
    {
        var (head, records) = Split(source.Block, source.Element);
        var plain = head.Select(l => KeyTail.Replace(l, "")).ToList();
        var header = plain.FindIndex(l => l.StartsWith("create static entity ", StringComparison.Ordinal));
        List<string> Named(List<string> lines, string variant) {
            var copy = new List<string>(lines);
            // Out of the source's folder: a new ODC entity moved into a folder of the Database branch is a gap of its own
            // (FolderInBranch: "Invalid ESpaceTreeFolder value 'Database'"), not of this family.
            copy[header] = Regex.Replace(Regex.Replace(copy[header], @"^create static entity \S+", "create static entity " + source.Element.Name + tag + variant), @" folder (\[(?:[^\]]|\]\])*\]|\S+)(?= )", "");
            return copy;
        }
        IEnumerable<string> Lines(Func<(string Attribute, string Value), bool> keep) =>
            records.Select((r, i) => RecordLine(r, r.Values.Where(keep), i == records.Count - 1, keep: false));
        yield return ("copy", Statement(Named(plain, "c"), Lines(_ => true)));
        if (source.Order == "Order" && !source.Element.Props.ContainsKey("OrderByAttribute"))
            yield return ("no-order-attribute", Statement(Named(WithoutAttribute(plain, "Order"), "o"), Lines(v => v.Attribute != "Order")));
        if (source.Label != null) yield return ("no-label-values", Statement(Named(plain, "l"), Lines(v => v.Attribute != source.Label)));
        if (source.Identifier != null) yield return ("no-id-values", Statement(Named(plain, "i"), Lines(v => v.Attribute != source.Identifier)));
        if (source.Order != null) yield return ("no-order-values", Statement(Named(plain, "n"), Lines(v => v.Attribute != source.Order)));
        if (source.Element.Props.GetValueOrDefault("Identifier") is { } id) {
            var unrequired = Named(plain, "r");
            var at = unrequired.FindIndex(l => l.StartsWith("  " + id + " ", StringComparison.Ordinal));
            unrequired[at] = Regex.Replace(unrequired[at], @" required(?=[ ,]|$)", "");
            yield return ("id-not-required", Statement(unrequired, Lines(_ => true)));
            yield return ("unique-index", Statement(Named(plain, "u"), Lines(_ => true)) + "\ncreate unique index UX_" + source.Element.Name + tag + "u on " + source.Element.Name + tag + "u (" + id + ");");
        }
    }

    // The real static entity edited as read: its identifier, label and order values left out of every record, and a new
    // record that writes only the other required values (copied from the last record).
    private static (string Text, string Added) Kept(Source source, string added)
    {
        var (head, records) = Split(source.Block, source.Element);
        var roles = new[] { source.Identifier, source.Label, source.Order }.OfType<string>().ToHashSet(StringComparer.Ordinal);
        var required = source.Element.Children.Where(a => a.Kind == "EntityAttribute" && a.Props.GetValueOrDefault("IsMandatory") == "True" && !roles.Contains(a.Name)
            && a.Name != source.Element.Props.GetValueOrDefault("Identifier")).Select(a => a.Name).ToList();
        var lines = records.Select(r => RecordLine(r, r.Values.Where(v => !roles.Contains(v.Attribute)), false, keep: true)).ToList();
        var last = records[^1];
        var extra = new DdlElement { Kind = last.Kind, Name = added };
        var values = last.Values.Where(v => required.Contains(v.Attribute)).ToList();
        // A Text identifier has no number to take: the new record writes its own.
        if (source.Element.Props.GetValueOrDefault("Identifier") is { } id && source.Identifier == null
            && source.Element.Children.First(a => a.Kind == "EntityAttribute" && a.Name == id) is var attribute && attribute.Props.GetValueOrDefault("IsAutoNumber") is not ("Yes" or "True")) {
            var length = int.TryParse(attribute.Props.GetValueOrDefault("Length"), out var n) && n > 0 ? n : added.Length;
            values.Insert(0, (id, "\"" + added[..Math.Min(length, added.Length)] + "\""));
        }
        lines.Add(RecordLine(extra, values, true, keep: false));
        return (Statement(head, lines), added);
    }

    // The copy, now kept: its Order attribute left out (when it has one) and a required attribute with a default added. With
    // orderNone the statement says the delete (`order none`); without it, it is a statement written from memory.
    private static string KeptEdit(string block, Source source, bool orderNone = true)
    {
        var entity = DdlParser.Parse(block).Elements[0];
        var (head, records) = Split(block, entity);
        if (source.Order == "Order" && !entity.Props.ContainsKey("OrderByAttribute")) {
            head = WithoutAttribute(head, "Order");
            var header = head.FindIndex(l => l.StartsWith("create static entity ", StringComparison.Ordinal));
            var open = head[header].LastIndexOf(" (", StringComparison.Ordinal);
            if (orderNone && open > 0) head[header] = head[header][..open] + " order none" + head[header][open..];
        }
        var members = Enumerable.Range(0, head.Count).Where(i => head[i].StartsWith("  ", StringComparison.Ordinal) && !head[i].StartsWith("  ///", StringComparison.Ordinal)).ToList();
        head[members[^1]] = Comma(head[members[^1]], true);
        head.Insert(members[^1] + 1, "  FxPeso Integer required default 7");
        return Statement(head, records.Select((r, i) => RecordLine(r, r.Values.Where(v => v.Attribute != "Order" || source.Order != "Order"), i == records.Count - 1, keep: true)));
    }

    // ---- the job and its proofs -----------------------------------------------------------------------------------------------

    private (JsonObject Result, string Candidate) Run(ModelHost host, string work, string name, string basePath, byte[] baseBytes, string ddl, string lane)
    {
        var job = Path.Combine(work, Regex.Replace(name, @"[^\w\-]", "_") + ".json");
        File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "spec", ["data"] = new JsonObject { ["ddl"] = ddl, ["basedOn"] = Sha(baseBytes) } }) }.ToJsonString());
        var candidate = Path.ChangeExtension(job, ".oml");
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, job, candidate))!.AsObject();
        output.WriteLine($"  {name} ({lane}): {clock.ElapsedMilliseconds} ms, accepted {result["accepted"]}, isValid {result["isValid"]}");
        return (result, candidate);
    }

    private static void Count(SortedDictionary<string, int> notes, JsonObject result)
    {
        foreach (var note in result["notes"] as JsonArray ?? [])
            if (note?["code"]?.ToString() is { } code) notes[code] = notes.GetValueOrDefault(code) + 1;
    }

    // Accepted on the first call, and the candidate reads back as the text with the platform's fill (the fixed point).
    private static DdlDocument Accepted(ModelHost host, string candidate, DataDdl before, string ddl, JsonObject result, string lane, string what)
    {
        Assert.True(result["accepted"]?.GetValue<bool>() == true, what + ": " + (result["policyMessages"]?.ToJsonString() ?? "") + " " + (result["dataContract"]?["differences"]?.ToJsonString() ?? ""));
        Assert.True(result["isValid"]?.GetValue<bool>() == true, what + ": " + result["validation"]?["new"]?.ToJsonString());
        Assert.Empty(result["validation"]!["new"]!.AsArray());
        Assert.True(result["dataContract"]?["accepted"]?.GetValue<bool>() == true, what + ": " + result["dataContract"]?["differences"]?.ToJsonString());
        var module = DdlParser.Parse(before.Text);
        var edit = DdlParser.Parse(ddl, lane);
        Assert.Empty(DdlConventions.Apply(edit, module).Problems);
        var expected = DdlParser.Parse(before.Text);
        foreach (var element in edit.Elements) {
            var at = element.Key.Length > 0 ? expected.Elements.FindIndex(e => e.Key == element.Key) : -1;
            if (at >= 0) expected.Elements[at] = element; else expected.Elements.Add(element);
        }
        DdlCompiler.ImplicitReferences(expected, module);
        var keys = new JsonObject();
        foreach (var spec in result["results"]!.AsArray().Where(r => r!["op"]!.ToString() == "spec"))
            foreach (var (name, key) in spec!["result"]!["keys"] as JsonObject ?? []) keys[name] = key!.DeepClone();
        foreach (var element in expected.All())
            if (element.Key.Length == 0 && keys[(element.Parent != null ? element.Parent.Name + "." : "") + element.Name] is JsonValue k) element.Key = k.GetValue<string>();
        var check = DdlBattery.CheckDocument(host, candidate, lane, expected);
        Assert.True(check.FixedPoint, what + ": " + string.Join(" | ", check.Mismatches.Take(10).Select(m => $"{m.Kind} {m.Name} @{m.Key} {m.Property}: {m.Expected} != {m.Actual}")));
        return DdlParser.Parse(host.BuildDdl(File.ReadAllBytes(candidate), "", lane).Text);
    }

    // The values themselves: the rule's, computed here from the source (never from DdlConventions).
    private static void Means(DdlDocument after, DataDdl before, Case c, string module)
    {
        var what = module + " " + c.Entity + " " + c.Variant;
        var entity = after.Elements.FirstOrDefault(e => e.Kind == "StaticEntity" && e.Name == c.Entity);
        Assert.True(entity != null, what + ": not in the module");
        var source = Records(c.Source.Element);
        var records = Records(entity!).ToDictionary(r => r.Name, StringComparer.Ordinal);
        string Quote(string name, string attribute) {
            var length = int.TryParse(c.Source.Element.Children.First(a => a.Name == attribute).Props.GetValueOrDefault("Length"), out var n) && n > 0 && name.Length > n ? n : name.Length;
            return "\"" + name[..length].Replace("\"", "\"\"") + "\"";
        }
        var identifier = c.Source.Element.Props.GetValueOrDefault("Identifier");
        if (c.Variant.StartsWith("kept:", StringComparison.Ordinal)) {
            // The records the module had keep every value; the new one takes the next id (none when AutoNumber), its name, its
            // position.
            foreach (var r in source)
                foreach (var (attribute, value) in r.Values) Assert.True(DdlRules.Same(value, Value(records[r.Name], attribute)), $"{what}: {r.Name}.{attribute} was {value}, now {Value(records[r.Name], attribute)}");
            var added = records[c.Variant[5..]];
            if (c.Source.Identifier != null && !c.Source.Auto) {
                var max = source.Select(r => long.TryParse(Value(r, c.Source.Identifier), out var v) ? v : 0).DefaultIfEmpty(0).Max();
                Assert.Equal((max + 1).ToString(), Value(added, c.Source.Identifier));
            }
            if (c.Source.Label != null) Assert.Equal(Quote(added.Name, c.Source.Label), Value(added, c.Source.Label));
            if (c.Source.Order != null) Assert.Equal((source.Count + 1).ToString(), Value(added, c.Source.Order));
            return;
        }
        Assert.Equal(source.Count, records.Count);
        var id = entity!.Children.First(a => a.Name == identifier);
        Assert.Equal("True", id.Props.GetValueOrDefault("IsMandatory"));
        Assert.False(id.Props.GetValueOrDefault("IsAutoNumber") is "Yes" or "True", what + ": a new static identifier is never AutoNumber");
        for (var i = 0; i < source.Count; i++) {
            var was = source[i]; var now = records[was.Name];
            var position = (i + 1).ToString();
            foreach (var (attribute, value) in was.Values) {
                if (c.Variant == "no-order-attribute" && attribute == "Order") continue;
                if (attribute == c.Source.Label && c.Variant == "no-label-values") Assert.Equal(Quote(was.Name, attribute), Value(now, attribute));
                else if (attribute == c.Source.Identifier && c.Variant == "no-id-values") Assert.Equal(position, Value(now, attribute));
                else if (attribute == c.Source.Order && c.Variant == "no-order-values") Assert.Equal(position, Value(now, attribute));
                else Assert.True(DdlRules.Same(value, Value(now, attribute)), $"{what}: {was.Name}.{attribute} {value} != {Value(now, attribute)}");
            }
            // An AutoNumber source (O11 before the rule) has no ids: the copy numbers its records by position.
            if (c.Source.Auto) Assert.Equal(position, Value(now, c.Source.Identifier!));
        }
        if (c.Variant == "no-order-attribute") Assert.DoesNotContain(entity.Children, a => a.Kind == "EntityAttribute" && a.Name == "Order");
        Assert.DoesNotContain(entity.Children, a => a.Kind == "EntityIndex");
    }

    // ---- the session of 2026-10-12 --------------------------------------------------------------------------------------------

    [Fact]
    public void TheSessionJobsOf20261012AreAcceptedFirst()
    {
        var (lane, kernel) = Lane();
        if (lane != "o11") return;   // an O11 module (VisitaCerta_CS)
        var fixture = JsonNode.Parse(File.ReadAllText(Path.Combine(kernel, "tests", "text-corpus", "session-20261012-static.json")))!;
        var basePath = fixture["base"]!["oml"]!.ToString();
        var files = new[] { basePath }.Concat(fixture["producers"]!.AsObject().Select(p => p.Value!["path"]!.ToString())).Concat(fixture["jobs"]!.AsArray().Select(j => j!["path"]!.ToString())).ToList();
        if (files.Any(f => !File.Exists(f))) { output.WriteLine("SKIPPED: the session's captures are not on this machine (" + files.First(f => !File.Exists(f)) + ")"); return; }
        Assert.Equal(fixture["base"]!["sha"]!.ToString(), Sha(File.ReadAllBytes(basePath)));
        Bind();
        var work = Path.Combine(kernel, ".local", "conventions-tests", "session-20261012");
        Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        var producers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (name, producer) in fixture["producers"]!.AsObject()) {
            Assert.Equal(producer!["sha"]!.ToString(), Sha(File.ReadAllBytes(producer["path"]!.ToString())));
            producers[name] = producer["path"]!.ToString();
        }
        foreach (var job in fixture["jobs"]!.AsArray()) {
            var path = job!["path"]!.ToString();
            Assert.Equal(job["sha"]!.ToString(), Sha(File.ReadAllBytes(path)));
            // The job under its own name, in this test's folder (nothing is written beside the session's files).
            var copy = Path.Combine(work, Path.GetFileName(path));
            File.Copy(path, copy, overwrite: true);
            // Junction 24-1-final: the session's AgendaRows aggregate also sorts by two If(...) expressions, which tx-publicacao
            // refuses on purpose (AGGREGATE_SORT_NOT_ATTRIBUTE: the OutSystems compiler fails on them). The job as sent is refused
            // for that alone; the static-entity conventions this test proves are judged on the same job without those two sorts.
            {
                var sent = Assert.ThrowsAny<Exception>(() => {
                    using (Anvil.Core.Delivery.Delivery.LinkSignatures(producers))
                        JobRunner.Run(host, basePath, copy, Path.ChangeExtension(copy, ".oml"), null, producers);
                });
                Assert.Contains("AGGREGATE_SORT_NOT_ATTRIBUTE", sent.Message);
                var document = JsonNode.Parse(File.ReadAllText(copy))!;
                var removed = WithoutExpressionSorts(document);
                Assert.Equal(2, removed);
                File.WriteAllText(copy, document.ToJsonString());
            }
            var clock = System.Diagnostics.Stopwatch.StartNew();
            JsonObject result;
            using (Anvil.Core.Delivery.Delivery.LinkSignatures(producers))
                result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, copy, Path.ChangeExtension(copy, ".oml"), null, producers))!.AsObject();
            var notes = (result["notes"] as JsonArray ?? []).Select(n => n?["code"]?.ToString()).OfType<string>().Distinct().ToList();
            output.WriteLine($"{job["name"]}: {clock.ElapsedMilliseconds} ms, accepted {result["accepted"]}, isValid {result["isValid"]}, notes [{string.Join(", ", notes)}] (before: {job["before"]})");
            Assert.True(result["accepted"]?.GetValue<bool>() == true, job["name"] + ": " + result["dataContract"]?["differences"]?.ToJsonString());
            Assert.True(result["isValid"]?.GetValue<bool>() == true, job["name"] + ": " + result["validation"]?["new"]?.ToJsonString());
            Assert.True(result["dataContract"]?["accepted"]?.GetValue<bool>() == true);
            foreach (var expected in job["notes"]!.AsArray()) Assert.Contains(expected!.ToString(), notes);
        }
    }

    // Removes every sort entry {by: "If(...)"} of the job (JSON logic ops); the number removed.
    private static int WithoutExpressionSorts(JsonNode? node)
    {
        var removed = 0;
        switch (node)
        {
            case JsonArray array:
                foreach (var item in array) removed += WithoutExpressionSorts(item);
                break;
            case JsonObject obj:
                if (obj["sort"] is JsonArray sorts)
                    foreach (var entry in sorts.ToList())
                        if (entry is JsonObject s && s["by"] is JsonValue by && by.TryGetValue<string>(out var text) && text.StartsWith("If(", StringComparison.Ordinal)) { sorts.Remove(entry); removed++; }
                foreach (var (_, value) in obj.ToList()) removed += WithoutExpressionSorts(value);
                break;
        }
        return removed;
    }
}
