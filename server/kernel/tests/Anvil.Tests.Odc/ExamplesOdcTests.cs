using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.PreflightRules;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// Os exemplos provados da faixa ODC (tests/jobs-odc/examples): cada job da pasta e aplicado headless pelo adaptador ODC
/// sobre a sua base, exatamente como OdcJobTests.JobAppliesAndVerifies faz com tests/jobs-odc (Verify, contrato de
/// mensagens, accepted, OML de saida) e grava o resultado com o carimbo de proveniencia em
/// .local/lane-odc/test-work/examples/&lt;job&gt;.result.json. A matriz (examples/matriz.json) diz o que cada job cobre;
/// o teste da matriz confere que ela so nomeia jobs que existem e que todo exemplo esta nela.
/// Precisa do ODC Studio instalado; sem ele os testes que aplicam jobs passam sem fazer nada, como em OdcJobTests.
/// </summary>
public class ExamplesOdcTests
{
    private static readonly string Root = FindRoot();
    private static readonly string Dir = Path.Combine(Root, "tests", "jobs-odc", "examples");
    private static readonly string Work = Path.Combine(Root, ".local", "lane-odc", "test-work", "examples");
    private static readonly string Fixture = Path.Combine(Root, "tests", "fixtures", "odc", "insurance-reactive-r8.oml");
    private static readonly string[] Kinds = ["widget", "pattern", "capability"];
    private static readonly string[] Levels = ["minimal", "typical", "rich"];
    // pending = sem exemplo ainda (fica para a proxima rodada, com o motivo em notes)
    private static readonly string[] Statuses = ["proven-existing", "new", "blocked", "pending"];

    /// <summary>Todo arquivo .json da pasta que e um job (tem ops ou jobs); a matriz e os outros dados ficam de fora.</summary>
    public static IEnumerable<object[]> Examples()
    {
        if (!Directory.Exists(Dir)) yield break;
        foreach (var f in Directory.GetFiles(Dir, "*.json").OrderBy(x => x, StringComparer.Ordinal))
            if (IsJob(f)) yield return new object[] { Path.GetFileNameWithoutExtension(f) };
    }

    private static bool IsJob(string file)
        => JsonNode.Parse(File.ReadAllText(file)) is JsonObject o && (o["ops"] is JsonArray || o["jobs"] is JsonArray);

    [Theory]
    [MemberData(nameof(Examples))]
    public void ExampleAppliesAndVerifies(string name)
    {
        if (!StudioAvailable()) return;
        var jobPath = Path.Combine(Dir, name + ".json");
        var job = JsonNode.Parse(File.ReadAllText(jobPath))!.AsObject();
        Directory.CreateDirectory(Work);
        var outPath = Path.Combine(Work, name + ".oml");
        // Um exemplo bloqueado (blocked-*.json) declara expectError: prova a recusa EXATA de hoje. Quando o kernel passar a
        // aceitar, este teste falha e a entrada da matriz deixa de ser blocked (o exemplo nunca fica velho em silencio).
        if (job["expectError"] != null)
        {
            var expected = job["expectError"] is JsonArray a ? a.Select(x => x!.GetValue<string>()).ToList() : [job["expectError"]!.GetValue<string>()];
            Exception? caught = null;
            try { JobRunner.Run(new ModelHost(Work), null, jobPath, outPath); } catch (Exception ex) { caught = ex; }
            Assert.True(caught != null, $"{name}: o job devia ser recusado e passou; atualize a matriz (deixou de ser blocked)");
            var text = Errors.Text(caught!);
            foreach (var e in expected) Assert.True(text.Contains(e, StringComparison.Ordinal), $"{name}: a recusa nao contem '{e}':\n{text}");
            return;
        }
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Work), null, jobPath, outPath))!.AsObject();
        result["provenance"] = JobProvenance.Stamp("Anvil.Tests.Odc", jobPath, Fixture);
        File.WriteAllText(Path.Combine(Work, name + ".result.json"), result.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        var isValid = result["isValid"]?.GetValue<bool>() ?? result["IsValid"]?.GetValue<bool>() ?? false;
        Assert.Equal(job["expectValid"]?.GetValue<bool>() ?? true, isValid);
        var validation = result["validation"]!;
        Assert.Empty(validation["unexpected"]!.AsArray());
        Assert.Empty(validation["missingExpected"]!.AsArray());
        Assert.Empty(validation["ambiguous"]!.AsArray());
        Assert.True(result["accepted"]!.GetValue<bool>(), $"{name}: {result["policyMessages"]}");
        Assert.True(File.Exists(outPath) && new FileInfo(outPath).Length > 1000, $"{name}: OML de saida ausente");
    }

    /// <summary>Um exemplo e lido por uma IA: uma descricao de uma linha, nunca vazia.</summary>
    [Theory]
    [MemberData(nameof(Examples))]
    public void ExampleHasAOneLineDescription(string name)
    {
        var job = JsonNode.Parse(File.ReadAllText(Path.Combine(Dir, name + ".json")))!.AsObject();
        var description = job["description"]?.GetValue<string>() ?? "";
        Assert.False(string.IsNullOrWhiteSpace(description), name + ": sem description");
        Assert.DoesNotContain('\n', description);
    }

    /// <summary>As regras de plataforma do ODC (PacoteEOdcRulesTests.EveryOdcSuiteJobPassesTheRules) tambem nos exemplos.</summary>
    [Fact]
    public void EveryExamplePassesTheOdcPlatformRules()
    {
        var refused = new List<string>();
        foreach (var name in Examples().Select(e => (string)e[0]))
        {
            var file = Path.Combine(Dir, name + ".json");
            JsonArray ops;
            try { ops = JobRunner.CollectOps(JsonNode.Parse(File.ReadAllText(file))!, Dir); } catch { continue; }
            foreach (var p in OdcPlatformRules.Check(ops, "odc"))
                refused.Add($"{name}.json op #{p["op"]} {p["code"]} {p["pointer"]}");
        }
        Assert.True(refused.Count == 0, string.Join("\n", refused));
    }

    /// <summary>
    /// A matriz de cobertura e dado de maquina: cada entrada tem id, kind, level, status e job validos; um job `new` existe
    /// nesta pasta, um `proven-existing` existe em tests/jobs-odc ou nesta pasta, um `blocked` traz o motivo em notes; e
    /// todo exemplo desta pasta aparece em pelo menos uma entrada.
    /// </summary>
    [Fact]
    public void TheMatrixNamesOnlyExistingJobsAndEveryExample()
    {
        var file = Path.Combine(Dir, "matriz.json");
        Assert.True(File.Exists(file), file);
        var matrix = JsonNode.Parse(File.ReadAllText(file))!.AsObject();
        var entries = matrix["entries"]!.AsArray().OfType<JsonObject>().ToList();
        Assert.NotEmpty(entries);
        var problems = new List<string>();
        var named = new HashSet<string>(StringComparer.Ordinal);
        foreach (var e in entries)
        {
            var id = e["id"]?.GetValue<string>() ?? "";
            var where = $"{id}/{e["level"]}";
            if (id.Length == 0) problems.Add("entrada sem id");
            if (!Kinds.Contains(e["kind"]?.GetValue<string>())) problems.Add(where + ": kind invalido");
            if (!Levels.Contains(e["level"]?.GetValue<string>())) problems.Add(where + ": level invalido");
            var status = e["status"]?.GetValue<string>();
            if (!Statuses.Contains(status)) { problems.Add(where + ": status invalido"); continue; }
            var job = e["job"]?.GetValue<string>() ?? "";
            if (status is "blocked" or "pending")
            {
                if (string.IsNullOrWhiteSpace(e["notes"]?.GetValue<string>())) problems.Add(where + ": " + status + " sem motivo em notes");
                // Um blocked pode citar o job de recusa (blocked-*.json, com expectError) que prova a recusa de hoje.
                if (!string.IsNullOrWhiteSpace(job))
                {
                    if (File.Exists(Path.Combine(Dir, job + ".json"))) named.Add(job);
                    else problems.Add($"{where}: job de recusa {job} nao existe em examples");
                }
                continue;
            }
            if (string.IsNullOrWhiteSpace(job)) { problems.Add(where + ": sem job"); continue; }
            foreach (var one in job.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
            {
                var inExamples = File.Exists(Path.Combine(Dir, one + ".json"));
                var inSuite = File.Exists(Path.Combine(Root, "tests", "jobs-odc", one + ".json"));
                if (status == "new" && !inExamples) problems.Add($"{where}: job novo {one} nao existe em examples");
                if (status == "proven-existing" && !inSuite && !inExamples) problems.Add($"{where}: job {one} nao existe");
                if (inExamples) named.Add(one);
            }
        }
        foreach (var name in Examples().Select(e => (string)e[0]))
            if (!named.Contains(name)) problems.Add($"exemplo {name} fora da matriz");
        Assert.True(problems.Count == 0, string.Join("\n", problems));
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(ExamplesOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
