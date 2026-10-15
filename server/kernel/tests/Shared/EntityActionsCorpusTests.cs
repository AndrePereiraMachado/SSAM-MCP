using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;

using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

// Linked into both test projects. The op entity-actions over the data models of the plan's corpus (kernel/tests/text-corpus,
// absolute paths; skipped with a notice when the captures are not on this machine), each module loaded on its own copy in
// memory, nothing saved: every server entity of the module gets its list, read, save and delete actions and their service
// actions in one op, and then
//   - the apply is not refused (the owner's rules, QUERY_IN_LOOP and the compile check run inside it);
//   - the Verify has no error the module did not have;
//   - every created action reads back as the text that created it, and its read is a fixed point of the text;
//   - the same op again is NO_CHANGE (every action unchanged, nothing written).
// ENTITY_ACTIONS_MODULES=<label,label> limits the modules; ENTITY_ACTIONS_OUT=<folder> writes each module's report there.
public sealed class EntityActionsCorpusTests(ITestOutputHelper output)
{
    private static (string Lane, string Kernel) Lane()
    {
        var odc = typeof(ModelHost).Assembly.GetType("Anvil.Core.StudioAssembliesOdc");
        var kernel = Path.GetDirectoryName(typeof(EntityActionsCorpusTests).Assembly.Location)!;
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

    // The data of the op the battery sends: every entity, an owner when an entity has one of these User Identifier attributes,
    // public server actions and their service actions.
    public static JsonObject Data() => new()
    {
        ["entities"] = "all",
        ["owner"] = new JsonObject { ["attribute"] = new JsonArray("CreatedBy", "CreatedByUserId", "OwnerId", "OwnerUserId", "OpenedBy", "CriadoPor", "UserId") },
        ["expose"] = new JsonObject { ["server"] = true, ["service"] = true },
    };

    [Fact]
    public void GeneratesTheActionsOfEveryDataModelOfTheCorpus()
    {
        var (lane, kernel) = Lane();
        // The plan's corpus, then the modules of tests/fixtures/entity-actions/corpus.json: more captures with entities (absolute
        // paths, skipped when missing) and data models built on the lane's blank fixture from a data text (ddl): the release
        // gate's model and a model of the shapes the generator decides on.
        string Full(string path) => Path.IsPathRooted(path) ? path : Path.Combine(kernel, path.Replace('/', Path.DirectorySeparatorChar));
        var entries = JsonNode.Parse(File.ReadAllText(Path.Combine(kernel, "tests", "text-corpus", "unique.json")))!.AsArray()
            .Concat(JsonNode.Parse(File.ReadAllText(Path.Combine(kernel, "tests", "fixtures", "entity-actions", "corpus.json")))!.AsArray())
            .Where(e => e!["lane"]!.ToString() == lane).Select(e => e!).ToList();
        var missing = entries.Where(e => !File.Exists(Full(e["oml"]!.ToString()))).Select(e => e["label"]!.ToString()).ToList();
        if (missing.Count > 0) output.WriteLine("WARNING: not on this machine, skipped: " + string.Join(", ", missing));
        entries = entries.Where(e => File.Exists(Full(e["oml"]!.ToString()))).ToList();
        if (entries.Count == 0) { output.WriteLine("SKIPPED: no module of the " + lane + " lane is on this machine"); return; }
        if (Environment.GetEnvironmentVariable("ENTITY_ACTIONS_MODULES") is { Length: > 0 } only)
        {
            var labels = only.Split(',', StringSplitOptions.TrimEntries).ToHashSet(StringComparer.OrdinalIgnoreCase);
            entries = entries.Where(e => labels.Contains(e["label"]!.ToString())).ToList();
        }
        Bind();
        var host = new ModelHost(Path.Combine(kernel, ".local", lane == "odc" ? "lane-odc" : "", "entity-actions-tests"));
        var outFolder = Environment.GetEnvironmentVariable("ENTITY_ACTIONS_OUT");
        var failures = new List<string>();
        int modules = 0, entities = 0, created = 0;
        foreach (var entry in entries)
        {
            var label = entry["label"]!.ToString();
            var ddl = entry["ddl"]?.ToString() is { } ddlPath ? File.ReadAllText(Full(ddlPath)) : null;
            var report = EntityActionsBattery.Run(host, File.ReadAllBytes(Full(entry["oml"]!.ToString())), label, Data(), ddl);
            if (outFolder != null) { Directory.CreateDirectory(outFolder); File.WriteAllText(Path.Combine(outFolder, lane + "-" + label + ".json"), report.ToJsonString(new JsonSerializerOptions { WriteIndented = true })); }
            output.WriteLine($"{label}: {report["entities"]} entities, {report["created"]} actions created ({report["bytes"]} bytes of text), {report["newErrors"]!.AsArray().Count} new Verify errors, {report["compileFindings"]?.AsArray().Count} compile findings over {report["compileChecked"]} elements, {report["padroes"]?.AsArray().Count} padroes findings, "
                + $"{report["readBackDifferent"]!.AsArray().Count} read back otherwise, second run {(report["secondNoChange"]?.GetValue<bool>() == true ? "NO_CHANGE" : "CHANGED")}, op {report["opMs"]} ms, {report["ms"]} ms");
            foreach (var failure in report["failures"]!.AsArray()) failures.Add(label + ": " + failure);
            if (report["entities"]!.GetValue<int>() > 0) modules++;
            entities += report["entities"]!.GetValue<int>();
            created += report["created"]!.GetValue<int>();
        }
        output.WriteLine($"total: {modules} modules with entities, {entities} entities, {created} actions");
        Assert.True(failures.Count == 0, string.Join("\n", failures.Take(30)));
    }

}
