using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>
/// The measure of the general language (R7) on the corpora of the batch lab, only with SSAM_FLOW_GENERAL_CORPUS (a folder
/// with the corpora in ssam-flow/1, as the lab's compiler expands them, `*.flow`, and the data of each, `*.ddl`). Method:
/// every action of a corpus is read as the grammar has it (FlowTextNormalizer with the schema of the corpus's DDL, which writes
/// the lab's `mapTo { * }` out: the baseline); it is then rewritten in the forms of R7, one candidate at a time, each kept only
/// when the text it gives expands (FlowTextNormalizer, the same schema) to the same canonical action as the baseline (the
/// printer's text of the parsed action, FlowExtract's canonical form, with the local declarations compared as a set: their
/// order is not the flow). The bytes of the baseline and of the rewrite are counted per corpus (UTF-8, LF). The trailing
/// `next` of a loop body and the `end` of the main flow (FLOW_BRANCH_FALLS_THROUGH, R5) are counted apart.
/// SSAM_FLOW_GENERAL_CORPUS_OUT: where the rewritten texts and report.json go.
/// </summary>
public sealed class FlowGeneralCorpusTests(ITestOutputHelper output)
{
    [Fact]
    public void TheGeneralFormsShortenTheLabCorporaAndExpandToTheSameActions()
    {
        var folder = Environment.GetEnvironmentVariable("SSAM_FLOW_GENERAL_CORPUS");
        if (string.IsNullOrEmpty(folder) || !Directory.Exists(folder)) return;
        var outFolder = Environment.GetEnvironmentVariable("SSAM_FLOW_GENERAL_CORPUS_OUT");
        // The lab's own texts of the corpora (part 2): the same file names as the expanded ones.
        var sources = Environment.GetEnvironmentVariable("SSAM_FLOW_GENERAL_SOURCES");
        var corpora = new Dictionary<string, (string[] Files, string Ddl)> {
            ["relief-cold"] = (Directory.GetFiles(folder, "relief-cold-*.flow"), Path.Combine(folder, "relief-cold.ddl")),
            ["marina-cold"] = (Directory.GetFiles(folder, "marina-cold-*.flow"), Path.Combine(folder, "marina-cold.ddl")),
            ["touring-live-100 (Vz)"] = (Directory.GetFiles(folder, "touring-live-100.flow"), Path.Combine(folder, "touring-live-100.ddl")),
        };
        var report = new List<object>();
        foreach (var (corpus, (files, ddl)) in corpora) {
            if (files.Length == 0) continue;
            var schema = Schema(File.Exists(ddl) ? File.ReadAllText(ddl) : "");
            long baseBytes = 0, r7Bytes = 0, r5Bytes = 0;
            int actions = 0, same = 0, unread = 0;
            var forms = new Dictionary<string, int>();
            var written = new StringBuilder();
            var details = new StringBuilder();
            var canons = new Dictionary<string, string>(StringComparer.Ordinal);
            var r7Of = new Dictionary<string, long>(StringComparer.Ordinal);
            foreach (var file in files.OrderBy(f => f, StringComparer.Ordinal))
                foreach (var text in Actions(File.ReadAllText(file))) {
                    actions++;
                    string baseline;
                    try { baseline = FlowTextNormalizer.Normalize(text, schema).Text; ModuleFlow.Read(baseline); }
                    catch (FormatException) { unread++; output.WriteLine(corpus + ": unread\n" + text); continue; }
                    var canon = Canon(baseline, schema);
                    if (canon == null) { unread++; continue; }
                    baseline = Strip(baseline);
                    var rewrite = new Rewriter(baseline, canon, schema);
                    var r7 = rewrite.Run(r5: false);
                    var r5 = new Rewriter(r7, canon, schema).Run(r5: true);
                    foreach (var (form, count) in rewrite.Forms) forms[form] = forms.GetValueOrDefault(form) + count;
                    if (Canon(r7, schema) == canon) same++;
                    baseBytes += Bytes(baseline); r7Bytes += Bytes(r7); r5Bytes += Bytes(r5);
                    written.Append(r7).Append('\n');
                    if (NameOf(text) is { } name) { canons[name] = canon; r7Of[name] = Bytes(r7); }
                }
            var reduction = baseBytes == 0 ? 0 : 1.0 - (double)r7Bytes / baseBytes;
            var withR5 = baseBytes == 0 ? 0 : 1.0 - (double)r5Bytes / baseBytes;
            output.WriteLine($"{corpus}: {actions} actions, {same} expand to the same action, {unread} unread; baseline {baseBytes} B, R7 {r7Bytes} B ({reduction:P1} less), with R5 fall-through {r5Bytes} B ({withR5:P1} less); forms {string.Join(", ", forms.OrderBy(f => f.Key).Select(f => f.Key + "=" + f.Value))}");
            // Part 2: the lab's own text of the corpus (its contracts and record operations), each action kept when the kernel
            // expands it to the action of the baseline, else counted as its R7 rewrite (a fallback, with the first reason).
            object? part2 = null;
            if (!string.IsNullOrEmpty(sources) && Directory.Exists(sources)) {
                long sourceBytes = 0;
                int matched = 0, fallback = 0;
                var rules = new Dictionary<string, int>();
                var reasons = new Dictionary<string, int>();
                foreach (var file in files.OrderBy(f => f, StringComparer.Ordinal)) {
                    var path = Path.Combine(sources, Path.GetFileName(file));
                    if (!File.Exists(path)) continue;
                    var (preamble, chunks) = SourceActions(File.ReadAllText(path));
                    sourceBytes += preamble.Length == 0 ? 0 : Bytes(Strip(preamble));
                    var normalized = FlowTextNormalizer.NormalizeAll(chunks.Select((c, k) => k == 0 ? preamble + c : c).ToList(), schema);
                    for (var k = 0; k < chunks.Count; k++) {
                        var name = NameOf(chunks[k]);
                        if (name == null || !canons.TryGetValue(name, out var canon)) continue;
                        if (normalized[k].Edits.Count > 0 && Canon(normalized[k].Text, schema) == canon) {
                            matched++; sourceBytes += Bytes(Strip(chunks[k]));
                            foreach (var rule in normalized[k].Edits.Select(e => e.Rule).Distinct()) rules[rule] = rules.GetValueOrDefault(rule) + 1;
                        } else {
                            fallback++; sourceBytes += r7Of[name];
                            var why = FlowGeneral.ExpandAll(chunks.Select((c, n) => n == 0 ? preamble + c : c).ToList(), schema).Texts[k].Problems.FirstOrDefault()
                                ?? (normalized[k].Edits.Count == 0 ? "not normalized" : "another action");
                            var key = Regex.Replace(why, @"^(?:text [0-9]+: )?line [0-9]+: ", "");
                            key = key.Length > 90 ? key[..90] : key;
                            reasons[key] = reasons.GetValueOrDefault(key) + 1;
                            output.WriteLine(corpus + " fallback " + name + ": " + why);
                            details.Append("=== ").Append(corpus).Append(' ').Append(name).Append(": ").Append(why).Append('\n')
                                .Append(Difference(Canon(normalized[k].Text, schema), canon)).Append('\n');
                            try { ModuleFlow.Read(FlowTextNormalizer.Normalize(normalized[k].Text, schema).Text); }
                            catch (FlowSyntaxException e) { details.Append("  ").Append(string.Join("\n  ", e.Errors.Take(3))).Append('\n'); }
                            catch (FormatException e) { details.Append("  ").Append(e.Message).Append('\n'); }
                        }
                    }
                }
                var part2Reduction = baseBytes == 0 ? 0 : 1.0 - (double)sourceBytes / baseBytes;
                output.WriteLine($"{corpus} part 2: {matched} actions from the lab's text, {fallback} fallback; {sourceBytes} B ({part2Reduction:P1} less)");
                part2 = new { matched, fallback, sourceBytes, reduction = part2Reduction, rules, reasons };
            }
            report.Add(new { corpus, actions, same, unread, baseBytes, r7Bytes, reduction, r5Bytes, withR5, forms, part2 });
            if (!string.IsNullOrEmpty(outFolder)) {
                Directory.CreateDirectory(outFolder);
                File.WriteAllText(Path.Combine(outFolder, corpus.Split(' ')[0] + ".r7.flow"), written.ToString());
                File.WriteAllText(Path.Combine(outFolder, corpus.Split(' ')[0] + ".fallbacks.txt"), details.ToString());
            }
            Assert.Equal(actions - unread, same);
        }
        if (!string.IsNullOrEmpty(outFolder)) File.WriteAllText(Path.Combine(outFolder, "report.json"), JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
    }

    // The first line where two canonical actions differ, with the line of each (null: the text does not read).
    private static string Difference(string? expanded, string canon)
    {
        if (expanded == null) return "  (the text does not read)";
        var a = expanded.Split('\n'); var b = canon.Split('\n');
        for (var i = 0; i < Math.Max(a.Length, b.Length); i++)
            if (i >= a.Length || i >= b.Length || a[i] != b[i]) return "  line " + (i + 1) + "\n  expanded: " + (i < a.Length ? a[i] : "(none)") + "\n  baseline: " + (i < b.Length ? b[i] : "(none)");
        return "  (same)";
    }

    private static string? NameOf(string text) => Regex.Match(text, @"^(?:server action|service action|client action|data action|action) ([A-Za-z_][\w./]*)", RegexOptions.Multiline) is { Success: true } m ? m.Groups[1].Value : null;

    // The text before the first action (contracts, bindings) and the actions, each with the description above it.
    private static (string Preamble, List<string> Actions) SourceActions(string text)
    {
        var lines = text.Replace("\r\n", "\n").Split('\n');
        var header = new Regex(@"^(?:server action|service action|client action|data action|action) \S");
        var first = Array.FindIndex(lines, l => header.IsMatch(l));
        if (first < 0) return ("", []);
        while (first > 0 && lines[first - 1].StartsWith("///", StringComparison.Ordinal)) first--;
        return (string.Join("\n", lines[..first]) + (first > 0 ? "\n" : ""), Actions(string.Join("\n", lines[first..])).ToList());
    }

    private static long Bytes(string text) => Encoding.UTF8.GetByteCount(text.Replace("\r\n", "\n"));

    // A text without its blank lines (what an edit emptied) and its trailing spaces.
    private static string Strip(string text) => string.Join("\n", text.Replace("\r\n", "\n").Split('\n').Where(l => l.Trim().Length > 0).Select(l => l.TrimEnd())) + "\n";

    // The canonical action of a text (the printer's text of what it expands to), its local declarations as a set.
    internal static string? Canon(string text, IFlowSchema? schema)
    {
        try {
            var normalized = FlowTextNormalizer.Normalize(text, schema).Text;
            var printed = ModuleFlow.Print(ModuleFlow.Read(normalized)).Text.Replace("\r\n", "\n").Split('\n').ToList();
            var locals = printed.Where(l => l.StartsWith("  local ", StringComparison.Ordinal)).Select(l => Regex.Replace(l, @" @\S+$", "")).Order(StringComparer.Ordinal).ToList();
            return string.Join("\n", printed.Where(l => !l.StartsWith("  local ", StringComparison.Ordinal)).Concat(locals));
        } catch (FormatException) { return null; }
    }

    // The actions of a corpus text, each with the description lines above it.
    private static IEnumerable<string> Actions(string text)
    {
        var lines = text.Replace("\r\n", "\n").Split('\n');
        var header = new Regex(@"^(?:server action|service action|client action|data action|action) \S");
        var starts = new List<int>();
        for (var i = 0; i < lines.Length; i++) {
            if (!header.IsMatch(lines[i])) continue;
            var start = i;
            while (start > 0 && lines[start - 1].StartsWith("///", StringComparison.Ordinal)) start--;
            starts.Add(start);
        }
        for (var k = 0; k < starts.Count; k++) {
            var end = k + 1 < starts.Count ? starts[k + 1] : lines.Length;
            var chunk = string.Join("\n", lines[starts[k]..end]).TrimEnd() + "\n";
            yield return chunk;
        }
    }

    // The records of a corpus's DDL (create entity ... (A T, ...); type X = {A: T; ...}) with the types the reader writes.
    internal static IFlowSchema Schema(string ddl)
    {
        var records = new Dictionary<string, IReadOnlyList<(string Name, string Type)>>(StringComparer.OrdinalIgnoreCase);
        foreach (Match entity in Regex.Matches(ddl, @"create (?:static )?entity (\w+)[^(]*\((.*?)\);", RegexOptions.Singleline)) {
            var attributes = new List<(string, string)>();
            foreach (var part in entity.Groups[2].Value.Split(',')) {
                var words = part.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (words.Length < 2) continue;
                var type = string.Join(" ", words.Skip(1).TakeWhile(w => w is not ("identifier" or "auto" or "required" or "default" or "unique" or "public")));
                if (words.Contains("identifier")) type = entity.Groups[1].Value + " Identifier";
                attributes.Add((words[0], Regex.Replace(type, @"\(\d+(?:,\d+)?\)$", "")));
            }
            records[entity.Groups[1].Value] = attributes;
        }
        foreach (Match structure in Regex.Matches(ddl, @"type (\w+)[^=]*= \{(.*?)\}", RegexOptions.Singleline)) {
            var attributes = new List<(string, string)>();
            foreach (var part in structure.Groups[2].Value.Split(';')) {
                var pair = part.Split(':', 2);
                if (pair.Length == 2) attributes.Add((pair[0].Trim(), Regex.Replace(pair[1].Trim(), @"\(\d+(?:,\d+)?\)$", "")));
            }
            records[structure.Groups[1].Value] = attributes;
        }
        return FlowSchema.Of(records);
    }

    // The forms of R7 written over an action's text, one candidate at a time, each kept when the text still expands to the
    // canonical action given.
    private sealed class Rewriter(string text, string canon, IFlowSchema schema)
    {
        public readonly Dictionary<string, int> Forms = new();
        private List<string> lines = text.Replace("\r\n", "\n").TrimEnd('\n').Split('\n').ToList();

        private static int Depth(string line) => (line.Length - line.TrimStart(' ').Length) / 2;
        private static string Content(string line) => line.TrimStart(' ');
        private static string Indent(int depth) => new(' ', depth * 2);
        private string Text => string.Join("\n", lines) + "\n";

        private bool Try(string form, List<string> candidate)
        {
            if (Canon(string.Join("\n", candidate) + "\n", schema) != canon) return false;
            lines = candidate;
            Forms[form] = Forms.GetValueOrDefault(form) + 1;
            return true;
        }

        private Dictionary<string, (string Role, string Type)> Declarations() => lines.Where(l => Depth(l) == 1)
            .Select(l => Regex.Match(Content(l), @"^(in|out|local) (\w+)\??: (.+?)(?: = .*)?$")).Where(m => m.Success)
            .GroupBy(m => m.Groups[2].Value, StringComparer.OrdinalIgnoreCase).ToDictionary(g => g.Key, g => (g.First().Groups[1].Value, g.First().Groups[3].Value), StringComparer.OrdinalIgnoreCase);

        // The lines under line i (deeper than it).
        private int BlockEnd(int i) { var j = i + 1; while (j < lines.Count && Depth(lines[j]) > Depth(lines[i])) j++; return j; }

        public string Run(bool r5)
        {
            if (r5) { FallThrough(); return Text; }
            for (var pass = 0; pass < 3; pass++) { Returns(); Requires(); Lets(); Copies(); SqlBinds(); Joins(); }
            return Text;
        }

        // `assign Out = v` (or a block of outputs) and `end` right after it: `return Out = v, ...`.
        private void Returns()
        {
            var declared = Declarations();
            for (var i = 0; i < lines.Count; i++) {
                var content = Content(lines[i]);
                if (!content.StartsWith("assign", StringComparison.Ordinal) || content.Contains(" @", StringComparison.Ordinal) || content.Contains("  # ", StringComparison.Ordinal)) continue;
                var depth = Depth(lines[i]);
                var pairs = new List<string>();
                var end = BlockEnd(i);
                if (content == "assign") pairs.AddRange(lines.Skip(i + 1).Take(end - i - 1).Select(Content));
                else pairs.Add(content["assign ".Length..]);
                if (end >= lines.Count || Content(lines[end]) != "end" || Depth(lines[end]) != depth) continue;
                if (pairs.Count == 0 || pairs.Any(p => Regex.Match(p, @"^(\w+)") is not { Success: true } m || !declared.TryGetValue(m.Groups[1].Value, out var d) || d.Role != "out")) continue;
                var candidate = lines.Take(i).Append(Indent(depth) + "return " + string.Join(", ", pairs)).Concat(lines.Skip(end + 1)).ToList();
                Try("return", candidate);
            }
        }

        // `if not (c):` whose true branch is `raise E(m)` (or a return): `require c else E(m)`.
        private void Requires()
        {
            for (var i = 0; i < lines.Count; i++) {
                var content = Content(lines[i]);
                if (!content.StartsWith("if not (", StringComparison.Ordinal) || !content.EndsWith("):", StringComparison.Ordinal)) continue;
                var condition = content["if not (".Length..^2];
                var depth = Depth(lines[i]);
                var end = BlockEnd(i);
                if (end - i != 2 || Depth(lines[i + 1]) != depth + 1) continue;
                var branch = Content(lines[i + 1]);
                string? otherwise = branch.StartsWith("raise ", StringComparison.Ordinal) ? branch["raise ".Length..] : branch.StartsWith("return", StringComparison.Ordinal) ? branch : null;
                if (otherwise == null || branch.Contains(" @", StringComparison.Ordinal)) continue;
                var candidate = lines.Take(i).Append(Indent(depth) + "require " + condition + " else " + otherwise).Concat(lines.Skip(end)).ToList();
                Try("require", candidate);
            }
        }

        // An assign node whose every target is a local it gives a value to: lets (with the type when it is not certain), the
        // locals' declarations gone.
        private void Lets()
        {
            for (var i = 0; i < lines.Count; i++) {
                var content = Content(lines[i]);
                if (!content.StartsWith("assign", StringComparison.Ordinal) || content.Contains(" @", StringComparison.Ordinal) || content.Contains("  # ", StringComparison.Ordinal)) continue;
                var declared = Declarations();
                var depth = Depth(lines[i]);
                var end = BlockEnd(i);
                var pairs = content == "assign" ? lines.Skip(i + 1).Take(end - i - 1).Select(Content).ToList() : [content["assign ".Length..]];
                var parsed = pairs.Select(p => Regex.Match(p, @"^(\w+) = (.+)$")).ToList();
                if (parsed.Count == 0 || parsed.Any(m => !m.Success || !declared.TryGetValue(m.Groups[1].Value, out var d) || d.Role != "local")) continue;
                if (parsed.Select(m => m.Groups[1].Value.ToLowerInvariant()).Distinct().Count() != parsed.Count) continue;
                foreach (var typed in new[] { false, true }) {
                    var lets = parsed.Select(m => Indent(depth) + "let " + m.Groups[1].Value + (typed ? ": " + declared[m.Groups[1].Value].Type : "") + " = " + m.Groups[2].Value);
                    var names = parsed.Select(m => m.Groups[1].Value).ToHashSet(StringComparer.OrdinalIgnoreCase);
                    var candidate = lines.Take(i).Concat(lets).Concat(lines.Skip(end)).Where(l => !(Depth(l) == 1 && Regex.Match(Content(l), @"^local (\w+):") is { Success: true } m && names.Contains(m.Groups[1].Value))).ToList();
                    if (Try("let", candidate)) break;
                }
            }
        }

        // An assign block `X = S` then `X.F = v`: `X = { ...S, F: v }`.
        private void Copies()
        {
            for (var i = 0; i < lines.Count; i++) {
                if (Content(lines[i]) != "assign") continue;
                var depth = Depth(lines[i]);
                var end = BlockEnd(i);
                var pairs = lines.Skip(i + 1).Take(end - i - 1).Select(Content).ToList();
                if (pairs.Count < 2 || Regex.Match(pairs[0], @"^(\w+) = (\w+(?:\.\w+)*)$") is not { Success: true } first) continue;
                var target = first.Groups[1].Value;
                var fields = pairs.Skip(1).Select(p => Regex.Match(p, "^" + target + @"\.(\w+) = (.+)$")).ToList();
                if (fields.Any(f => !f.Success)) continue;
                var copy = target + " = { ..." + first.Groups[2].Value + ", " + string.Join(", ", fields.Select(f => f.Groups[1].Value + ": " + f.Groups[2].Value)) + " }";
                var candidate = lines.Take(i).Append(Indent(depth) + "assign " + copy).Concat(lines.Skip(end)).ToList();
                Try("copy", candidate);
            }
        }

        // `in P: T = P` under a sql node, P a variable of that type: the line goes.
        private void SqlBinds()
        {
            var declared = Declarations();
            for (var i = 0; i < lines.Count; i++) {
                var m = Regex.Match(Content(lines[i]), @"^in (\w+): (.+) = (\w+)$");
                if (!m.Success || Depth(lines[i]) < 2 || !m.Groups[1].Value.Equals(m.Groups[3].Value, StringComparison.Ordinal)) continue;
                if (!declared.TryGetValue(m.Groups[1].Value, out var d) || d.Type != m.Groups[2].Value) continue;
                var candidate = lines.Where((_, k) => k != i).ToList();
                if (Try("sql-bind", candidate)) i--;
            }
        }

        // A jump the structured reading writes (the step after its block): the jump goes, and the id it named when no other
        // line names it.
        private void Joins()
        {
            for (var i = 0; i < lines.Count; i++) {
                var m = Regex.Match(Content(lines[i]), @"^-> @(\S+)$");
                if (!m.Success) continue;
                var id = m.Groups[1].Value;
                var candidate = lines.Where((_, k) => k != i).ToList();
                if (!candidate.Any(l => Content(l) == "-> @" + id)) candidate = candidate.Select(l => l.EndsWith(" @" + id, StringComparison.Ordinal) ? l[..^(id.Length + 2)] : l).ToList();
                if (Try("join", candidate)) i--;
            }
        }

        // R5 (counted apart): the `next` that ends a loop body and the `end` of the main flow.
        private void FallThrough()
        {
            for (var i = 0; i < lines.Count; i++) {
                var content = Content(lines[i]);
                if (content != "next" && !(content == "end" && Depth(lines[i]) == 1)) continue;
                var candidate = lines.Where((_, k) => k != i).ToList();
                if (Try("fall-through", candidate)) i--;
            }
        }
    }
}
