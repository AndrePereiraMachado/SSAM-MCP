using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

// Linked into both test projects: screens from entities and blocks (gen-screen/1) over the Reactive and Mobile modules of the
// plan's corpus (tests/contracts/screen-html/corpus.json; captures by absolute path, never committed, absent = skipped with a
// warning). Per module, on a copy (the capture is only read): the three entities the module's facts rank first (its own,
// writable, with references), the generate op as a job; then no new message of the Verify, the C1 fixed point of every
// generated root, and the same request over the result being NO_CHANGE. Minutes per module: it runs when
// SSAM_GEN_SCREEN_CORPUS=1 (the proof jobs of both lanes run always).
internal static class ScreenGeneratorCorpus
{
    public const string Switch = "SSAM_GEN_SCREEN_CORPUS";

    /// <summary>The proof of one generate job: accepted with no new message, every generated root a fixed point, the same
    /// request again NO_CHANGE. Returns the produced module and the generate receipt.</summary>
    public static (string Output, JsonObject Receipt) Proof(ModelHost host, string? basePath, string jobPath, string work, JsonArray entities, ITestOutputHelper output)
    {
        Directory.CreateDirectory(work);
        var produced = Path.Combine(work, "out.oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, jobPath, produced))!.AsObject();
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]!.ToJsonString());
        Assert.Empty(result["validation"]!["new"]!.AsArray());
        Assert.Null(result["highWarnings"]);
        var receipt = result["results"]!.AsArray().Select(r => r!["result"]?["generate"]).OfType<JsonObject>().Single();
        var roots = receipt["create"]!.AsArray().Where(c => c!["kind"]!.ToString() != "action").Select(c => c!["name"]!.ToString()).ToList();
        Assert.NotEmpty(roots);
        var check = host.HtmlCheck(File.ReadAllBytes(produced), null);
        var reading = host.HtmlRead(File.ReadAllBytes(produced), null, withKeys: false)["documents"]!.AsArray().OfType<JsonObject>().ToList();
        foreach (var name in roots)
        {
            var doc = check["documents"]!.AsArray().Select(d => d!.AsObject()).Single(d => d["root"]!.ToString() == name);
            Assert.True(doc["ops"]!.GetValue<int>() == 0 && doc["problemCount"]!.GetValue<int>() == 0 && doc["deterministic"]!.GetValue<bool>(), name + ": " + doc.ToJsonString());
            // The owner's rules over the reading: no Visible, no script, no JSON, no opaque widget, a table and no cards.
            var html = reading.FirstOrDefault(d => d["root"]?.ToString() == name)?["html"]?.ToString();
            if (html != null)
            {
                foreach (var rule in new[] { "os-Visible=", "<script", "javascript:", "JSONSerialize", "<os-opaque", "card-sectioned" }) Assert.DoesNotContain(rule, html);
                if (name.EndsWith("List", StringComparison.Ordinal)) Assert.Matches("<table[^>]*class=\"table\"", html);
            }
        }
        var again = Path.Combine(work, "again.json");
        File.WriteAllText(again, new JsonObject { ["description"] = "gen-screen: the same request again", ["ops"] = new JsonArray(new JsonObject { ["op"] = "screen", ["data"] = new JsonObject { ["generate"] = new JsonObject { ["entities"] = entities.DeepClone() } } }) }.ToJsonString());
        var second = JsonSerializer.SerializeToNode(JobRunner.Run(host, produced, again, Path.Combine(work, "out2.oml")))!.AsObject();
        var receipt2 = second["results"]!.AsArray().Select(r => r!["result"]?["generate"]).OfType<JsonObject>().Single();
        Assert.Equal("NO_CHANGE", receipt2["code"]?.ToString());
        output.WriteLine($"{Path.GetFileName(jobPath)}: {roots.Count} roots, {receipt["generatedBytes"]} bytes generated, compile {receipt["timings"]?["compileMs"]} ms; again NO_CHANGE ({receipt2["unchanged"]!.AsArray().Count} unchanged)");
        return (produced, receipt);
    }

    public static void Check(string manifestFile, string lane, ModelHost host, string work, ITestOutputHelper output)
    {
        if (Environment.GetEnvironmentVariable(Switch) != "1") { output.WriteLine($"WARNING: the gen-screen corpus runs with {Switch}=1 (minutes per module): skipped."); return; }
        var manifest = JsonNode.Parse(File.ReadAllText(manifestFile))!.AsObject();
        var modules = manifest["modules"]!.AsArray().Select(m => m!.AsObject()).Where(m => m["lane"]!.GetValue<string>() == lane && m["screens"]!.GetValue<bool>()).ToList();
        var present = modules.Where(m => File.Exists(m["oml"]!.GetValue<string>())).ToList();
        foreach (var m in modules.Except(present)) output.WriteLine("WARNING: capture absent, module skipped: " + m["label"]);
        if (present.Count == 0) { output.WriteLine("WARNING: no capture of the " + lane + " corpus on this machine: skipped."); return; }
        var problems = new List<string>();
        var ran = 0;
        foreach (var m in present)
        {
            var label = m["label"]!.GetValue<string>();
            var oml = m["oml"]!.GetValue<string>();
            var bytes = File.ReadAllBytes(oml);
            if (Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant() != m["sha256"]!.GetValue<string>()) { problems.Add(label + ": the capture changed"); continue; }
            var facts = ModelSession.ReadGenModule(host, bytes);
            if (facts.Runtime is not ("Reactive" or "Mobile")) { output.WriteLine($"{label}: {facts.Runtime}, no screens to generate"); continue; }
            var entities = Pick(facts);
            if (entities.Count < 3) { output.WriteLine($"{label}: {entities.Count} entities with two attributes or more: skipped"); continue; }
            var dir = Path.Combine(work, label);
            Directory.CreateDirectory(dir);
            var job = Path.Combine(dir, "job.json");
            var list = new JsonArray(entities.Select(e => (JsonNode)e).ToArray());
            var request = new JsonObject { ["description"] = "gen-screen corpus: three entities", ["ops"] = new JsonArray(new JsonObject { ["op"] = "screen", ["data"] = new JsonObject { ["generate"] = new JsonObject { ["entities"] = list.DeepClone() } } }) };
            File.WriteAllText(job, request.ToJsonString());
            // A refusal whose every problem carries its patch (a screen name the module already uses: GEN_SCREEN_NAME_TAKEN
            // names the free one) is followed once, as the agent follows it: the patched job is the request, and the same
            // request again must be NO_CHANGE. The measurement of SSAM-HTML.md applied it by hand (note 1: 2 rounds). A refusal
            // without patches, or a second refusal, is a problem of the module.
            for (var round = 1; ; round++)
            {
                var asked = request["ops"]![0]!["data"]!["generate"]!["entities"]!.AsArray();
                try { Proof(host, oml, job, dir, asked, output); ran++; if (round > 1) output.WriteLine($"{label}: proven in {round} rounds"); break; }
                catch (Exception error) when (round == 1 && RefusalPatches(error) is { Count: > 0 } patches)
                {
                    foreach (var patch in patches) ApplyPatch(request, patch);
                    File.WriteAllText(job, request.ToJsonString());
                    output.WriteLine($"{label}: {Errors.FindCoded(error)!.Code}, the refusal's patch applied: {string.Join(" ", patches.Select(p => p.ToJsonString()))}");
                }
                catch (Exception error) { problems.Add(label + (round > 1 ? $" (round {round})" : "") + ": " + error.GetBaseException().Message[..Math.Min(600, error.GetBaseException().Message.Length)]); break; }
            }
        }
        output.WriteLine($"{lane}: {ran} modules generated and proven");
        Assert.True(problems.Count == 0, problems.Count + " problem(s):\n" + string.Join("\n", problems));
    }

    /// <summary>The distinct patches of a coded refusal when every one of its problems carries one (the same patch repeated in
    /// each problem of an entity counts once); none otherwise.</summary>
    private static List<JsonArray> RefusalPatches(Exception error)
    {
        var problems = Errors.FindCoded(error)?.Problems?.OfType<JsonObject>().ToList() ?? [];
        if (problems.Count == 0 || problems.Any(p => p["patch"] is not JsonArray { Count: > 0 })) return [];
        return problems.Select(p => (JsonArray)p["patch"]!).GroupBy(p => p.ToJsonString()).Select(g => g.First()).ToList();
    }

    /// <summary>RFC 6902 replace/add/remove on object members and array items (what the refusals' patches use).</summary>
    private static void ApplyPatch(JsonObject document, JsonArray patch)
    {
        foreach (var step in patch.OfType<JsonObject>())
        {
            var parts = step["path"]!.GetValue<string>().Split('/').Skip(1).Select(s => s.Replace("~1", "/").Replace("~0", "~")).ToArray();
            JsonNode parent = document;
            foreach (var part in parts[..^1]) parent = parent is JsonArray a ? a[int.Parse(part)]! : parent[part]!;
            var last = parts[^1];
            var op = step["op"]!.GetValue<string>();
            if (parent is JsonArray list)
            {
                var index = last == "-" ? list.Count : int.Parse(last);
                if (op == "remove") list.RemoveAt(index);
                else if (op == "add") list.Insert(index, step["value"]?.DeepClone());
                else list[index] = step["value"]?.DeepClone();
            }
            else if (op == "remove") parent.AsObject().Remove(last);
            else parent[last] = step["value"]?.DeepClone();
        }
    }

    /// <summary>The entities a corpus run generates: not static, not of the platform's modules, two attributes or more besides
    /// the identifier; the module's own and writable first, then those with references, by name.</summary>
    public static List<string> Pick(GenModule facts)
    {
        var platform = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "(System)", "System", "Users", "OutSystemsUI", "OutSystemsCharts", "OutSystemsMaps" };
        int Score(GenEntity e) => (e.Producer == null ? 100 : 0) + (e.Writable ? 50 : 0) + Math.Min(10, e.Attributes.Count) + (e.Attributes.Any(a => a.Target != null) ? 5 : 0);
        return facts.Entities.Where(e => !e.Static && !platform.Contains(e.Producer ?? "") && e.Attributes.Count(a => a.Name != e.IdName) >= 2)
            .OrderByDescending(Score).ThenBy(e => e.Name, StringComparer.Ordinal).Take(3).Select(e => e.Name).ToList();
    }
}
