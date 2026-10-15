using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Core;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

// Linked into both test projects. DL2 of the SSAM text plan on real modules (the captures of the plan's corpus, absolute paths
// in kernel/tests/text-corpus; skipped with a notice when they are not on this machine):
//   - the battery: edits of every module's data text, applied back through the spec op's ddl form, come back equal (the
//     module is a fixed point of the edited text, no key changes outside the edit), at least 1,000 edits over the corpus;
//   - renaming an attribute (of an entity and of a structure, to a name the Studio would guess a type from) is only a rename
//     and keeps the key;
//   - the request of the transcript of 2026-10-10 ("criar entidades … índice único", 20 calls and 4 of 5 deliveries refused)
//     goes in one read and one deliver, refused zero times.
public sealed class TextRoundTripDataBackNativeTests(ITestOutputHelper output)
{
    private static (string Lane, string Kernel) Lane()
    {
        var odc = typeof(ModelHost).Assembly.GetType("Anvil.Core.StudioAssembliesOdc");
        var kernel = Path.GetDirectoryName(typeof(TextRoundTripDataBackNativeTests).Assembly.Location)!;
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

    private static List<JsonNode> Corpus(string kernel, string lane) =>
        JsonNode.Parse(File.ReadAllText(Path.Combine(kernel, "tests", "text-corpus", "unique.json")))!.AsArray().Where(e => e!["lane"]!.ToString() == lane).Select(e => e!).ToList();

    // The edits per lane the corpus gives at the battery's seed (measured on 2026-10-11): the floor of the acceptance, at
    // least 1,000 edits over the corpus.
    private static readonly Dictionary<string, int> Floors = new() { ["o11"] = 1000, ["odc"] = 200 };

    [Fact]
    public void EditsOfTheRealTextsComeBackEqual()
    {
        var (lane, kernel) = Lane();
        var entries = Corpus(kernel, lane);
        if (entries.All(e => !File.Exists(e["oml"]!.ToString()))) { output.WriteLine("SKIPPED: the text corpus of the " + lane + " lane is not on this machine"); return; }
        Bind();
        var work = Path.Combine(kernel, ".local", lane == "odc" ? "lane-odc" : "", "text-back-tests");
        var (total, modules) = DdlBattery.RunManifest(new ModelHost(work), Path.Combine(kernel, "tests", "text-corpus", "unique.json"), lane, 0, 11, output.WriteLine);
        foreach (var module in modules.OfType<JsonObject>()) output.WriteLine(module["label"] + ": " + module["exact"] + " of " + module["edits"]);
        foreach (var (kind, count) in total.ByKind) output.WriteLine("  " + kind + " " + count);
        Assert.True(total.Failures.Count == 0, string.Join("\n", total.Failures.Take(10).Select(f => f.Module + " batch " + f.Batch + " [" + f.Edits + "]: " + f.Error)));
        Assert.Equal(total.Edits, total.Exact);
        if (entries.All(e => File.Exists(e["oml"]!.ToString()))) Assert.True(total.Edits >= Floors[lane], "edits " + total.Edits + " < " + Floors[lane]);
    }

    [Fact]
    public void RenamingAnAttributeIsOnlyARenameAndKeepsTheKey()
    {
        var (lane, kernel) = Lane();
        var present = Corpus(kernel, lane).Where(e => File.Exists(e["oml"]!.ToString())).ToList();
        if (present.Count == 0) { output.WriteLine("SKIPPED: the text corpus of the " + lane + " lane is not on this machine"); return; }
        Bind();
        var host = new ModelHost(Path.Combine(kernel, ".local", lane == "odc" ? "lane-odc" : "", "text-back-tests"));
        var proved = 0;
        foreach (var entry in present) {
            string? attributeKey = null, memberKey = null, attributeName = null, memberName = null;
            var answer = DdlBattery.Apply(host, entry["oml"]!.ToString(), lane, text => {
                var document = DdlParser.Parse(text);
                var data = DataDdlBlocks(text);
                // An attribute of an entity and an attribute of a structure, each renamed in its statement; the structure's to a
                // name that ends with an entity of the module (the Studio guesses a type from such a name, "NomeProduto").
                var entity = document.Elements.FirstOrDefault(e => DdlRules.IsEntityKind(e.Kind) && e.Children.Any(c => c.Kind == "EntityAttribute" && Renameable(c, e)));
                var structure = document.Elements.FirstOrDefault(e => e.Kind == "Structure" && e.Children.Any(c => DdlRules.IsBareName(c.Name)));
                if (entity == null || structure == null) return "";
                var attribute = entity.Children.First(c => c.Kind == "EntityAttribute" && Renameable(c, entity));
                var member = structure.Children.First(c => DdlRules.IsBareName(c.Name));
                var guess = document.Elements.FirstOrDefault(e => e.Kind == "ServerEntity" && DdlRules.IsBareName(e.Name))?.Name ?? "Guess";
                (attributeKey, attributeName, memberKey, memberName) = (attribute.Key, attribute.Name + "Ren", member.Key, "Nome" + guess);
                return Line(data[entity.Key], attribute.Key, attribute.Name, attributeName) + "\n\n" + Line(data[structure.Key], member.Key, member.Name, memberName);
            });
            if (attributeKey == null) continue;
            output.WriteLine(entry["label"] + ": " + answer["ops"]!.ToJsonString());
            Assert.True(answer["error"] == null, answer["error"]?.ToString());
            Assert.Empty(answer["problems"]!.AsArray());
            // Only the two renames, by key.
            var ops = answer["ops"]!.AsArray().Select(o => o!["op"] + " " + o["target"] + " " + o["name"]).ToList();
            Assert.Equal(["rename @" + attributeKey + " " + attributeName, "rename @" + memberKey + " " + memberName], ops);
            Assert.Equal(1, answer["result"]!["rounds"]!.AsArray().Count);
            // The module after: the same text with the two names, every key and every type as before.
            var expected = answer["before"]!.ToString();
            expected = Regex.Replace(expected, @"(?m)^(  )\S+( .* -- @" + Regex.Escape(attributeKey) + ")$", "${1}" + attributeName + "$2");
            expected = Regex.Replace(expected, @"(?m)^(  )\S+(: .* -- @" + Regex.Escape(memberKey!) + ")$", "${1}" + memberName + "$2");
            Assert.Equal(Body(expected), Body(answer["after"]!.ToString()));
            proved++;
            if (proved == 2) break;
        }
        Assert.True(proved > 0, "no module of the corpus has an entity and a structure to rename");

        static bool Renameable(DdlElement attribute, DdlElement entity) =>
            DdlRules.IsBareName(attribute.Name) && !entity.Props.Values.Contains(attribute.Name) && !entity.Children.Any(c => c.Columns.Contains(attribute.Name) || c.Values.Any(v => v.Attribute == attribute.Name));
        // The line of an element renamed inside its statement.
        static string Line(string block, string key, string from, string to) =>
            Regex.Replace(block, @"(?m)^  " + Regex.Escape(from) + @"(?=[ :].* -- @" + Regex.Escape(key) + "$)", "  " + to);
        static string Body(string text) => text[(text.IndexOf('\n') + 1)..];
    }

    // The blocks of a module's text by the key of their element (the text is the header and the blocks, a blank line apart).
    private static Dictionary<string, string> DataDdlBlocks(string text)
    {
        var blocks = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var block in text.Replace("\r\n", "\n").Split("\n\n").Skip(1)) {
            var trimmed = block.Trim('\n');
            var head = trimmed.Split('\n').First(l => !l.StartsWith("///", StringComparison.Ordinal));
            if (Regex.Match(head, @" -- @(\S+)$") is { Success: true } m) blocks[m.Groups[1].Value] = trimmed;
        }
        return blocks;
    }

    [Fact]
    public void TheRequestOfTheTranscriptGoesInOneReadAndOneDeliver()
    {
        var (lane, kernel) = Lane();
        if (lane != "o11") return;   // an O11 module (Haiku_CS)
        var fixture = JsonNode.Parse(File.ReadAllText(Path.Combine(kernel, "tests", "text-corpus", "transcript-20261010-data.json")))!;
        var basePath = fixture["base"]!["oml"]!.ToString();
        if (!File.Exists(basePath)) { output.WriteLine("SKIPPED: the base of the request is not on this machine (" + basePath + ")"); return; }
        Assert.Equal(fixture["base"]!["sha"]!.ToString(), Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(basePath))), StringComparer.OrdinalIgnoreCase);
        Bind();
        var work = Path.Combine(kernel, ".local", "text-back-tests", "transcript");
        Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        // Call 1: the module's data text (ssam_map view "ddl").
        var read = host.BuildDdl(File.ReadAllBytes(basePath), "", lane);
        Assert.StartsWith("-- ssam-ddl/1 module=Haiku_CS", read.Text);
        // Call 2: one deliver of the job (data and timer as the text, the roles and the logic as the transcript delivered them).
        var jobPath = Path.Combine(work, "transcript-20261010-data-job.json");
        File.WriteAllText(jobPath, fixture["job"]!.ToJsonString());
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, jobPath, Path.Combine(work, "candidate.oml")))!.AsObject();
        output.WriteLine("apply " + clock.ElapsedMilliseconds + " ms; " + result["timings"]!.ToJsonString());
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString());
        Assert.True(result["isValid"]!.GetValue<bool>(), result["details"]?.ToJsonString());
        Assert.Empty(result["validation"]!["new"]!.AsArray());
        // What the candidate holds is the text that was sent: its data reads back as the two texts, under the keys the apply gave.
        var specs = result["results"]!.AsArray().Where(r => r!["op"]!.ToString() == "spec").Select(r => r!["result"]!).ToList();
        Assert.Equal(2, specs.Count);
        var keys = new JsonObject();
        foreach (var spec in specs) foreach (var (name, key) in spec["keys"]!.AsObject()) keys[name] = key!.DeepClone();
        var texts = fixture["job"]!["ops"]!.AsArray().Where(o => o!["op"]!.ToString() == "spec").Select(o => o!["data"]!["ddl"]!.ToString()).ToList();
        var text = read.Text + "\n" + string.Join("\n\n", texts);
        var check = DdlBattery.Check(host, Path.Combine(work, "candidate.oml"), lane, text, keys);
        Assert.True(check.FixedPoint, check.ParseError + string.Join("\n", check.Mismatches.Take(10).Select(m => $"{m.Kind} {m.Name} {m.Property}: {m.Expected} | {m.Actual}")));
        output.WriteLine("baseline " + fixture["baseline"]!.ToJsonString() + "; now 2 calls, 0 refusals, " + check.Exact + " data elements exact");
    }
}
