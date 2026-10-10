using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// The ODC lane of JobTests: every job in tests/jobs-odc is applied headless through the ODC adapter
/// (StudioAdapter.Runtime is OdcRuntime in this build) over its ODC fixture, and has to satisfy expectValid and declare
/// each new message. The full result of each job is written next to the output OML (<job>.result.json) as the proof.
/// Needs the ODC Studio installed; without it the tests are skipped.
/// </summary>
public class OdcJobTests
{
    private static readonly string Root = FindRoot();
    private static readonly string Work = Path.Combine(Root, ".local", "lane-odc", "test-work");
    private static readonly string Fixture = Path.Combine(Root, "tests", "fixtures", "odc", "insurance-reactive-r8.oml");

    public static IEnumerable<object[]> Jobs()
    {
        var dir = Path.Combine(Root, "tests", "jobs-odc");
        if (!Directory.Exists(dir)) yield break;
        foreach (var f in Directory.GetFiles(dir, "*.json").OrderBy(x => x)) yield return new object[] { Path.GetFileNameWithoutExtension(f) };
    }

    /// <summary>
    /// O espelho do NegativeJobTests da faixa O11 para a faixa ODC: jobs em tests/jobs-odc-negative com `expectError`
    /// TEM de falhar, e a mensagem tem de conter cada trecho esperado. E a outra metade da prova de apagar: a recusa
    /// que nomeia os consumidores vale tanto quanto o caminho limpo, e o texto que a LLM le e o texto testado.
    /// </summary>
    public static IEnumerable<object[]> NegativeJobs()
    {
        var dir = Path.Combine(Root, "tests", "jobs-odc-negative");
        if (!Directory.Exists(dir)) yield break;
        foreach (var f in Directory.GetFiles(dir, "*.json").OrderBy(x => x))
        {
            var job = JsonNode.Parse(File.ReadAllText(f))!.AsObject();
            if (job["expectError"] != null) yield return new object[] { Path.GetFileNameWithoutExtension(f) };
        }
    }

    [Theory]
    [MemberData(nameof(NegativeJobs))]
    public void JobFailsWithTheTeachingMessageInTheOdcLane(string jobName)
    {
        if (!StudioAvailable()) return;
        var jobPath = Path.Combine(Root, "tests", "jobs-odc-negative", jobName + ".json");
        var job = JsonNode.Parse(File.ReadAllText(jobPath))!.AsObject();
        var expected = job["expectError"] is JsonArray a ? a.Select(x => x!.GetValue<string>()).ToList()
            : new List<string> { job["expectError"]!.GetValue<string>() };
        Exception? caught = null;
        try { JobRunner.Run(new ModelHost(Work), null, jobPath, Path.Combine(Work, jobName + ".oml")); }
        catch (Exception ex) { caught = ex; }
        Assert.True(caught != null, $"{jobName}: o job devia falhar e passou");
        var text = Errors.Text(caught!);
        foreach (var e in expected)
            Assert.True(text.Contains(e, StringComparison.Ordinal), $"{jobName}: a mensagem nao contem '{e}':\n{text}");
    }

    [Fact]
    public void TheRuntimeIsTheOdcAdapter()
    {
        if (!StudioAvailable()) return;
        Assert.Equal("odc", StudioAdapter.Runtime.Platform);
        Assert.IsType<OdcRuntime>(StudioAdapter.Runtime);
        Assert.StartsWith("1.", StudioAdapter.Runtime.IdeVersion);
    }

    [Fact]
    public void TheFixtureLoadsSavesAndReloads()
    {
        if (!StudioAvailable()) return;
        var host = new ModelHost(Work);
        var first = host.Inspect(Fixture);
        Assert.True(first.Objects > 100, "fixture has objects: " + first.Objects);
        var saved = host.RoundTrip(File.ReadAllBytes(Fixture), Path.Combine(Work, "insurance-reactive-r8.roundtrip.oml"));
        Assert.True(saved.BytesOut > 1000, "saved OML has bytes: " + saved.BytesOut);
        Assert.Equal(first.Objects, saved.Reloaded.Objects);
    }

    /// <summary>
    /// O ODC expoe na API PUBLICA o diff de 3 vias do Studio: IModelServices.Diff devolve um IMatchTree com
    /// MatchType, DifferenceType, MergeAction por objeto E por propriedade, mais Dump() e Merge(). O O11 so tem
    /// `bool Merge(my, other, base)`, sem arvore. Isto e headless: nao passa pela bridge nem pela GUI.
    /// Aqui provamos o diff (leitura); aplicar Merge() sobre um modulo do tenant e decisao de quem entrega.
    /// </summary>
    [Fact]
    public void TheOdcApiDiffsTwoModelsHeadlessAndSeesTheChangeOfAJob()
    {
        if (!StudioAvailable()) return;
        var changed = Path.Combine(Work, "screen-basic.oml");
        if (!File.Exists(changed)) return;          // depende do job screen-basic ter corrido; ele mesmo e um teste daqui
        var summary = OdcDiff.Compare(new ModelHost(Work), File.ReadAllBytes(Fixture), File.ReadAllBytes(changed));
        File.WriteAllText(Path.Combine(Work, "diff-summary.json"), summary.ToJsonString(Json.Pretty));
        Assert.True(summary["matches"]!.GetValue<int>() > 0, "a arvore de match veio vazia");
        // A tela que o job criou existe so no foreign: e isso que o diff tem de apontar, sem GUI e sem bridge.
        var onlyInForeign = summary["onlyInForeign"]!.AsArray();
        Assert.Contains(onlyInForeign, o => o!["name"]?.ToString() == "WfProofScreen");
        Assert.Equal(0, summary["conflicts"]!.GetValue<int>());
    }

    /// <summary>
    /// A invariante do cache de bases do worker (BaseModelCache) na faixa ODC: a instancia de reserva que um job toma
    /// (carregada pela sobrecarga cancelavel e percorrida com o worker ocioso) e o MESMO modelo que um load fresco, pelo
    /// diff nativo da plataforma. E o que permite entrega-la a um job no lugar do load.
    /// </summary>
    [Fact]
    public void TheWorkerSpareIsTheSameModelAsAFreshLoad()
    {
        if (!StudioAvailable()) return;
        SpareEqualsFreshLoad();   // the Studio types resolve only after the bind above
    }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static void SpareEqualsFreshLoad()
    {
        var bytes = File.ReadAllBytes(Fixture);
        var cache = BaseModelCache.Create(BaseCacheOptions.Default);
        Assert.Null(cache.Take(Fixture, bytes).Model);
        cache.Idle(CancellationToken.None);
        var spare = cache.Take(Fixture, bytes);
        Assert.True(spare.Receipt["hit"]!.GetValue<bool>(), spare.Receipt.ToJsonString());
        var fresh = new ModelHost(Work).Load(bytes);
        try
        {
            using var tree = OutSystems.ModelAPILoader.Loader.ModelServicesInstance.Diff((OutSystems.Model.IESpace)fresh, (OutSystems.Model.IESpace)spare.Model!, (OutSystems.Model.IESpace)fresh);
            var matches = tree.AllMatches.ToList();
            Assert.True(matches.Count > 1000, "matches: " + matches.Count);
            var differing = matches.Where(m => m.Difference != OutSystems.Model.Merge.DifferenceType.None).Select(m => m.Type + "/" + m.Difference).Take(5).ToList();
            Assert.Empty(differing);
        }
        finally { ModelHost.Release(spare.Model); ModelHost.Release(fresh); }
    }

    /// <summary>
    /// O tradutor de C# para actions nativas (src/Anvil.CSharp) na faixa ODC: a mesma fonte autorada que a faixa O11
    /// usa vira spec de logica, a spec vira ops, e os ops entram no modulo do tenant pessoal. O motor existe desde o
    /// Anvil e atravessa a outra plataforma sem mudanca nenhuma no compilador.
    ///
    /// Diferenca de plataforma que este teste registra: cada action gerada nasce com a guarda de autenticacao
    /// (um If comparando GetUserId() com NullIdentifier()), e o Verify do ODC marca esse padrao com
    /// ExpressionComparingDifferentIdentifiers -- o mesmo aviso que o InsuranceApp ja tem em 55 lugares proprios.
    /// E aviso de plataforma, nao erro do tradutor: o modulo continua valido.
    /// </summary>
    [Theory]
    [InlineData("PatternSemantics", 7)]
    public void AuthoredCSharpBecomesNativeActionsInTheOdcLane(string fixture, int minimoDeActions)
    {
        if (!StudioAvailable()) return;
        var source = Path.Combine(Root, "tests", "csharp", fixture + ".cs.txt");
        if (!File.Exists(source)) return;
        var work = Path.Combine(Work, "csharp", fixture); Directory.CreateDirectory(work);
        var contract = new JsonObject { ["csharpSource"] = File.ReadAllText(source) };
        ModuleSpecification.Validate(contract);
        var compiled = ModuleSpecification.Normalize(contract);
        var actions = compiled["logic"]?["actions"]?.AsArray();
        Assert.True(actions?.Count >= minimoDeActions, "o compilador produziu " + (actions?.Count ?? 0) + " actions");

        var host = new ModelHost(work);
        var job = Path.Combine(work, fixture.ToLowerInvariant() + "-csharp.json");
        var outPath = Path.Combine(work, fixture.ToLowerInvariant() + "-csharp.oml");
        // An ODC app exposes no public server action (the kernel refuses it, as the live Studio does): here the authored
        // public entries stay private server actions, so each one also raises UnusedUserAction (tolerated below).
        var planned = host.PlanModuleSpecification(Fixture, contract);
        foreach (var op in planned.OfType<JsonObject>().Where(o => o["op"]?.ToString() == "logic"))
            foreach (var action in op["data"]?["actions"]?.AsArray().OfType<JsonObject>() ?? [])
                if (action["kind"]?.ToString() != "service" && action["public"]?.GetValue<bool>() == true) action["public"] = false;
        File.WriteAllText(job, new JsonObject { ["ops"] = planned }.ToJsonString());
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, Fixture, job, outPath))!.AsObject();
        File.WriteAllText(Path.Combine(work, "apply-result.json"), result.ToJsonString(Json.Pretty));

        Assert.True(result["isValid"]!.GetValue<bool>(), "o modulo ficou invalido");
        Assert.True(new FileInfo(outPath).Length > 1000, "nao saiu OML");
        // As unicas mensagens novas sao a guarda de autenticacao descrita acima; qualquer outra e regressao.
        var inesperadas = result["validation"]!["unexpected"]!.AsArray()
            .Where(m => m!["id"]?.ToString() is not ("ExpressionComparingDifferentIdentifiers" or "UnusedUserAction")).ToList();
        Assert.Empty(inesperadas);
    }

    /// <summary>
    /// O limite conhecido do tradutor na faixa ODC, registrado como teste para nao ser esquecido: fontes que usam
    /// intrinsecos do framework (System.String.Trim, .Length, ...) exigem que o controlador resolva o runtime de C#
    /// antes do plano, o que no O11 vem de um produtor entregue por CSharpRuntimeDelivery -- caminho que o ODC nao
    /// tem headless (ImportReference recusa; referencias sao refrescadas ao vivo pela bridge). O erro e explicito,
    /// nao silencioso. Quando o ODC ganhar esse caminho, este teste falha e deve ser trocado pelo caso positivo.
    /// </summary>
    [Theory]
    [InlineData("TextSemantics")]
    [InlineData("NullableMembers")]
    public void AuthoredCSharpThatNeedsTheRuntimeRefusesWithTheReasonInTheOdcLane(string fixture)
    {
        if (!StudioAvailable()) return;
        var source = Path.Combine(Root, "tests", "csharp", fixture + ".cs.txt");
        if (!File.Exists(source)) return;
        var work = Path.Combine(Work, "csharp", fixture); Directory.CreateDirectory(work);
        var contract = new JsonObject { ["csharpSource"] = File.ReadAllText(source) };
        var host = new ModelHost(work);
        var erro = Assert.Throws<InvalidOperationException>(() => host.PlanModuleSpecification(Fixture, contract));
        Assert.Contains("resolve the C# runtime requirements", erro.Message);
        Assert.Contains("IFrameworkIntrinsic:System.String", erro.Message);
    }

    [Fact]
    public void TheVerifyCatalogComesFromTheInstalledOdcStudio()
    {
        if (!StudioAvailable()) return;
        var all = StudioAdapter.Runtime.VerifyDefinitions;
        Assert.True(all.Count > 100, "definitions: " + all.Count);
        Assert.All(all, d => Assert.False(string.IsNullOrEmpty(d.Id)));
    }

    /// <summary>
    /// O manifesto de ids desta faixa (catalog/odc) e o do ODC Studio instalado: e contra ele, e nao contra as listas do
    /// O11, que um job ODC declara expectedMessages (avisos so do ODC, como UnusedGlobalEvent). Quando o Studio atualiza,
    /// este teste aponta o ficheiro que falta: `anvil-odc verify-catalog --out catalog/odc/verify-messages-&lt;versao&gt;.json`.
    /// </summary>
    [Fact]
    public void TheVerifyIdManifestIsTheInstalledOdcCatalog()
    {
        if (!StudioAvailable()) return;
        Assert.Equal("odc", MessageExpectations.Lane);
        var file = Path.Combine(MessageExpectations.CatalogDirectory(Root, "odc"), $"verify-messages-{StudioAdapter.Runtime.IdeVersion}.json");
        Assert.True(File.Exists(file), $"{file} ausente: gere com `anvil-odc verify-catalog --out catalog/odc/verify-messages-{StudioAdapter.Runtime.IdeVersion}.json`");
        var ids = JsonNode.Parse(File.ReadAllText(file))!.AsArray();
        Assert.All(ids, id => Assert.Single(id!.AsObject())); // so o id, nunca o texto do fabricante
        Assert.Equal(StudioAdapter.Runtime.VerifyDefinitions.Select(d => d.Id).Order(StringComparer.Ordinal), ids.Select(i => i!["id"]!.ToString()).Order(StringComparer.Ordinal));
    }

    [Theory]
    [MemberData(nameof(Jobs))]
    public void JobAppliesAndVerifies(string jobName)
    {
        if (!StudioAvailable()) return;
        var jobPath = Path.Combine(Root, "tests", "jobs-odc", jobName + ".json");
        var job = JsonNode.Parse(File.ReadAllText(jobPath))!.AsObject();
        var host = new ModelHost(Work);
        var outPath = Path.Combine(Work, jobName + ".oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, jobPath, outPath))!.AsObject();
        // Provenance of this execution, so a later reader (discovery) can tell a result of the CURRENT combination
        // from a historical one, instead of trusting the file (JobProvenance: shared with the O11 suite and the CLIs).
        result["provenance"] = JobProvenance.Stamp("Anvil.Tests.Odc", jobPath, Fixture);
        File.WriteAllText(Path.Combine(Work, jobName + ".result.json"), result.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        var isValid = result["isValid"]?.GetValue<bool>() ?? result["IsValid"]?.GetValue<bool>() ?? false;
        Assert.Equal(job["expectValid"]?.GetValue<bool>() ?? true, isValid);
        var validation = result["validation"]!;
        Assert.Empty(validation["unexpected"]!.AsArray());
        Assert.Empty(validation["missingExpected"]!.AsArray());
        Assert.Empty(validation["ambiguous"]!.AsArray());
        Assert.True(result["accepted"]!.GetValue<bool>(), $"{jobName}: {result["policyMessages"]}");
        Assert.True(File.Exists(outPath) && new FileInfo(outPath).Length > 1000, $"{jobName}: OML de saida ausente");
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(OdcJobTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
