using System.Diagnostics;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Hosting;

namespace Anvil.Cli.Odc;

/// <summary>
/// CLI da faixa ODC: os mesmos subcomandos finos da faixa O11, um envelope JSON por comando em stdout e o registro em
/// stderr, mas sobre Anvil.Core.Odc, ou seja, o mesmo kernel compilado contra o ODC Studio. O `anvil` (SS11) nao serve
/// aqui: o Program.cs dele usa tipos so-SS11 (HeadlessSession, Publisher, BridgeClient, MergeProbe).
///
/// Headless (so o kernel, sem Studio aberto):
///   apply --job &lt;job.json&gt; --out &lt;saida.oml&gt; [--base &lt;base.oml&gt;] [--work &lt;dir&gt;] [--producer Nome=&lt;oml&gt;]
///         [--developer-id &lt;autor&gt;] [--base-content-sha256 &lt;sha&gt;]   autor e identidade de conteudo do pedido (worker);
///                                                   a saida traz baseSha256 (sha cru do --base) para o builder
///   check-job --job &lt;job.json&gt;                     preflight barato, sem subir o runtime
///   create-blank --kind &lt;SegmentationKind&gt; --name &lt;Nome&gt; --out &lt;modulo.oml&gt; [--connection ai-model|mcp|knowledge-base:&lt;Nome&gt;]... [--work &lt;dir&gt;]
///                                                   modulo em branco do tipo dado (Mobile, BusinessProcess, AIAgent...),
///                                                   criado pelo modelo instalado e recarregado como o apply carrega a base;
///                                                   cada --connection junta uma conexao offline com uma action do mesmo nome
///   create-app --kind reactive|mobile|library|mobile-library --name &lt;App&gt; --out &lt;dir&gt; [--module &lt;Modulo&gt;]
///              [--template-oml &lt;template.oml&gt; --template-key &lt;chave&gt;] [--color #RRGGBB] [--description &lt;t&gt;] [--icon &lt;png&gt;]
///              [--tenant &lt;host&gt;] [--author &lt;email&gt;] [--plugins-dir &lt;cache de plugins do Studio, do bridge&gt;]
///                                                   app ou library nova como o ODC Studio monta (clone do template / ESpace.Create),
///                                                   com OML, recibo e manifesto de criacao para o bridge; nunca sobrescreve
///   inspect --oml &lt;modulo.oml&gt; [--work &lt;dir&gt;]      nome, tipo, objetos, referencias, validacao
///   digest --oml &lt;modulo.oml&gt; [--out &lt;f.txt&gt;]     resumo do modulo (ssam-digest), guardado junto do indice do modulo
///   flow --oml &lt;modulo.oml&gt; [--action &lt;nome|@chave&gt;] [--out &lt;f&gt;]  as actions em texto (ssam-flow/1), com o ponto fixo de cada uma
///   rich-index --oml &lt;modulo.oml&gt;                 indice rico (ssam-rich-index): valores, expressoes, argumentos, referencias
///   read-serve --state &lt;f&gt; --generation &lt;g&gt;       leitor residente so de leitura (resumo e indice rico do ssam_map)
///   references --oml &lt;modulo.oml&gt;                  as referencias registradas no modulo
///   verify-catalog [--id &lt;VerifyId&gt;] [--out &lt;f&gt;]   o catalogo publico lido da instalacao do ODC Studio; --out grava
///                                                  so os ids (catalog/odc/verify-messages-&lt;versao&gt;.json)
///   merge-order --base &lt;captura.oml&gt; --candidate &lt;candidato.oml&gt; --out &lt;first-pass.oml&gt;
///                                                  os defaults que o merge nativo perderia (MergeOrder) e o candidato sem eles
///   api --op logic|spec|screen|html|html-visual    a sintaxe fechada da op
///   external-library build --spec &lt;spec.json&gt; --out &lt;pasta nova&gt; | contents --spec|--package|--server &lt;f&gt; | diff --base &lt;f&gt; --new &lt;f&gt;
///                                                  Biblioteca Externa ODC: projeto net10, dotnet publish e zip deterministico
///
/// Sessao viva (pelo bridge do SSAM-Hybrid-ODC, com o ODC Studio aberto no tenant do trabalho):
///   status | snapshot --module &lt;M&gt; | merge --manifest &lt;m.json&gt;
///   deliver --module &lt;M&gt; --job &lt;j&gt; --evidence &lt;dir&gt; --feature &lt;nome&gt; --owners &lt;a,b&gt; --change "&lt;texto&gt;"
///   refresh --consumer &lt;C&gt; [--producer &lt;P&gt;]
///   publish --manifest &lt;m.json&gt; --authorization "&lt;texto&gt;"   recusa sem o texto; nunca o inventa
///
/// Worker residente (a mesma ideia do `anvil serve` da faixa O11, que e o que faz a faixa O11 responder em 2 s):
///   serve [--port 4547] [--log-dir &lt;dir&gt;]   uma linha JSON por pedido em 127.0.0.1, o MESMO Dispatch em processo,
///                                            com as DLLs do ODC Studio ja carregadas e o JIT quente.
///   ping | gc                                estado do processo (uteis pelo worker)
///
/// Codigos de saida: 0 ok, 1 recusado (o JSON diz porque), 2 uso, 3 transporte do bridge, 4 erro.
/// </summary>
internal static class Program
{
    private static int _served;

    private const string Usage = """
usage: anvil-odc <comando> [--flags]
  headless: apply | check-job | create-blank | create-app | inspect | references | verify-catalog | merge-order | api | external-library
  sessao:   status | snapshot | merge | deliver | refresh | publish
  worker:   serve [--port 4547] | ping | gc
  detalhe em docs/lanes.md e src/Anvil.Core.Odc/Adapters.ODC/README.md
""";

    private static int Main(string[] args)
    {
        if (args.Length == 0 || args[0] is "-h" or "--help") { Console.Error.WriteLine(Usage); return 2; }
        if (args[0] == "serve") { Serve(args); return 0; }
        var sw = Stopwatch.StartNew();
        try
        {
            var data = Dispatch(args[0], args);
            if (data == null) { Console.Error.WriteLine("comando desconhecido: " + args[0] + Environment.NewLine + Usage); return 2; }
            var envelope = Envelope(args[0], data, sw.ElapsedMilliseconds);
            Emit(envelope);
            return envelope["ok"]!.GetValue<bool>() ? 0 : 1;
        }
        catch (BridgeCallException ex)
        {
            Emit(new JsonObject { ["ok"] = false, ["command"] = args[0], ["elapsedMs"] = sw.ElapsedMilliseconds,
                ["transport"] = true, ["executed"] = ex.Executed, ["error"] = ex.Message });
            return 3;
        }
        catch (Exception ex) { Emit(ErrorEnvelope(args[0], ex, sw.ElapsedMilliseconds)); return 4; }
    }

    /// <summary>Um comando -> um objeto (null = comando desconhecido). O mesmo Dispatch serve o processo frio e o worker.</summary>
    private static object? Dispatch(string command, string[] args) => command switch
    {
        // ---- headless ---------------------------------------------------------------------------------
        "apply" => Apply(args),
        "check-job" => CheckJob(args),
        "create-blank" => CreateBlank(args),
        "create-app" => CreateApp(args),
        "inspect" => Inspect(args),
        "debug-scope" => NativeDebugScope.Read(Host(args), Need(args, "--oml"), Need(args, "--expected-sha256"), Need(args, "--node-key"), Need(args, "--function-key"), Opt(args, "--previous-node-key")),
        "digest" => Digest(args),
        "ddl" => Ddl(args),
        "flow" => Flow(args),
        "flow-battery" => FlowBatteryCmd(args),
        // Checagem de compilação over a whole module (CompileCheck.cs): zero findings on what the Studio made.
        "compile-check" => CompileCheck.Module(Host(args), File.ReadAllBytes(Need(args, "--oml")), Path.GetFileNameWithoutExtension(Need(args, "--oml")),
            int.TryParse(Opt(args, "--max"), out var compileMax) ? compileMax : 40),
        "flow-merge-battery" => FlowMergeBatteryCmd(args),
        "flow-create-battery" => FlowCreateBatteryCmd(args),
        "rich-index" => RichIndex(args),
        "html-census" => HtmlCensus(args),
        "html-read" => HtmlRead(args),
        "html-check" => HtmlCheck(args),
        "html-edit" => HtmlEdit(args),
        "html-edit-battery" => HtmlEditBattery(args),
        "html-recreate" => HtmlRecreate(args),
        "read-serve" => ReadServe(args),
        "census" => Census(args),
        "references" => Host(args).References(File.ReadAllBytes(Need(args, "--oml"))),
        "verify-catalog" => VerifyCatalogCmd(args),
        "merge-order" => MergeOrderPlan(args),
        "api" => Need(args, "--op") == "native" ? Native(args) : CommandSurface.Schema(Need(args, "--op")),
        // An External Library from its spec (project, dotnet publish, deterministic zip), its contents and their diff; no Studio.
        "external-library" => Anvil.Core.ExternalLibraries.ExternalLibraryCommand.Run(args),
        // ---- sessao viva ------------------------------------------------------------------------------
        "status" => new BridgeClientOdc().StatusBrief(),
        "snapshot" => new StudioSessionOdc(new BridgeClientOdc()).Snapshot(Need(args, "--module")).Json,
        "merge" => new StudioSessionOdc(new BridgeClientOdc()).Merge(Need(args, "--manifest")).ToJson(),
        "deliver" => Deliver(args),
        "refresh" => new ReferenceServiceOdc(new BridgeClientOdc()).Refresh(Need(args, "--consumer"), Opt(args, "--producer")),
        "publish" => Publish(args),
        // ---- processo ---------------------------------------------------------------------------------
        "ping" => new { pid = Environment.ProcessId, workingSetMB = Environment.WorkingSet >> 20, gcMB = GC.GetTotalMemory(false) >> 20,
            served = _served, platform = StudioAdapter.Runtime.Platform, studio = StudioAssembliesOdc.Directory },
        "gc" => Gc(),
        _ => null,
    };

    // ---- comandos ---------------------------------------------------------------------------------------

    /// <summary>primeira-certa A1: check-job judges the properties of the job's sets against the Model API (PropertyRules)
    /// when the ODC Studio is installed; unbound, that rule was skipped and its problems came one round later, from apply.</summary>
    private static object CheckJob(string[] args)
    {
        try { StudioAssembliesOdc.Bind(null); } catch { /* no ODC Studio here: the rule stays a warning */ }
        return Anvil.Core.Preflight.CheckJobCommand.Run(args);
    }

    private static object Apply(string[] args)
    {
        var job = Need(args, "--job");
        JobRunner.CheckJobName(job);        // a regra do nome antes de subir o runtime, como na faixa O11
        JobRunner.ValidateJob(job);
        // the job a patched or partial job corrects (job-patch.mjs): the CSS loss guard of the preflight compares the two
        JobPreflight.BasedOn.Value = Opt(args, "--based-on") is { Length: > 0 } basedOn ? Path.GetFullPath(basedOn) : null;
        // Every problem at once, with the code and the structured problems in the error envelope (PREFLIGHT_REFUSED, I2).
        // primeira-certa A2: the preflight runs inside JobRunner, which goes on to the base check, the apply and the Verify
        // when the base loads, and refuses once with every phase (verifyRan says whether the Verify ran).
        var producers = args.Select((a, i) => (a, i)).Where(x => x.a == "--producer" && x.i + 1 < args.Length)
            .Select(x => args[x.i + 1].Split('=', 2)).Where(p => p.Length == 2)
            .ToDictionary(p => p[0], p => Path.GetFullPath(p[1]), StringComparer.OrdinalIgnoreCase);
        var outPath = Need(args, "--out");
        var basePath = Opt(args, "--base");
        // I3 (C02 B1): the raw sha256 of the base this apply read, so the builder can tell that the kernel's receipt is of
        // exactly this (base, candidate) pair and skip loading both models again.
        var baseSha256 = basePath == null ? null : Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(basePath))).ToLowerInvariant();
        var contentSha256 = Opt(args, "--base-content-sha256");
        // B2 (C02): the author of this request (the snapshot's developerId) and the content identity of its base; a resident
        // worker serves requests of several authors and captures, each with its own (OdcRuntime.WithDeveloperId).
        var result = OdcRuntime.WithDeveloperId(Opt(args, "--developer-id"), () =>
            BaseModelCache.WithContent(basePath, contentSha256, () => JobRunner.Run(Host(args), basePath, job, outPath, Log, producers)));
        var data = System.Text.Json.JsonSerializer.SerializeToNode(result)!.AsObject();
        if (baseSha256 != null) data["baseSha256"] = baseSha256;
        if (contentSha256 != null) data["baseContentSha256"] = contentSha256.ToLowerInvariant();
        if (Opt(args, "--developer-id") is { } developer) data["developerId"] = developer;
        // O mesmo carimbo que a suite grava (JobProvenance), para que um `ssam job` tambem deixe evidencia com identidade.
        // Com a fixture da faixa, como a suite: sem fixtureSha256 a descoberta classifica o resultado como historico.
        var node = data.DeepClone().AsObject();
        try { node["provenance"] = JobProvenance.Stamp("Anvil.Cli.Odc", job, LaneFixture(job)); } catch (Exception ex) { Log("provenance not stamped: " + ex.Message); }
        File.WriteAllText(Path.ChangeExtension(outPath, ".result.json"), node.ToJsonString(Json.Pretty));
        return data;
    }

    /// <summary>A fixture da faixa ODC (a mesma de Anvil.Tests.Odc e da descoberta), na raiz do repositorio do job, senao
    /// na deste kernel (a mesma politica das fixtures declaradas).</summary>
    private static string LaneFixture(string job)
        => JobSources.FixturePath("tests/fixtures/odc/insurance-reactive-r8.oml", Path.GetDirectoryName(Path.GetFullPath(job))!, "lane fixture");
    /// <summary>`create-blank`: um modulo em branco de um SegmentationKind, sem tenant nem Studio, para servir de base a
    /// jobs que o app CrossDevice recusa (workflows, agentes, OnSync). Nunca sobrescreve: a saida tem de ser nova.</summary>
    private static object CreateBlank(string[] args)
    {
        var outPath = Path.GetFullPath(Need(args, "--out"));
        if (File.Exists(outPath)) throw new IOException("a saida ja existe (create-blank nunca sobrescreve): " + outPath);
        var connections = args.Select((a, i) => (a, i)).Where(x => x.a == "--connection" && x.i + 1 < args.Length).Select(x => args[x.i + 1]).ToList();
        var created = OdcBlankModule.Create(Host(args), Need(args, "--kind"), Need(args, "--name"), outPath, connections);
        Log($"{created["name"]} ({created["kind"]}): {created["objects"]} objects, isValid={created["isValid"]}, {created["bytes"]} bytes");
        return created;
    }

    /// <summary>`create-app`: uma app (clone do template baixado pelo bridge) ou library (ESpace.Create) nova, montada como o
    /// ODC Studio monta antes de subir; grava o OML, o recibo e o manifesto de criacao. Nunca sobrescreve.</summary>
    private static object CreateApp(string[] args)
    {
        var spec = new OdcAppSpec(Need(args, "--kind"), Need(args, "--name"), Opt(args, "--module"), Opt(args, "--template-oml"), Opt(args, "--template-key"),
            Opt(args, "--color"), Opt(args, "--description"), Opt(args, "--icon"), Opt(args, "--tenant"), Opt(args, "--author"), Opt(args, "--plugins-dir"));
        // C25: the clone and the manifest carry the request's author, in a cold process and in the resident worker alike.
        return OdcRuntime.WithDeveloperId(Opt(args, "--author"), () => OdcAppFactory.Create(Host(args), spec, Need(args, "--out"), Log));
    }

    /// <summary>`merge-order --base &lt;capture.oml&gt; --candidate &lt;candidate.oml&gt; --out &lt;first-pass.oml&gt;`: the delivery's
    /// merge order computed headless (MergePlanner over the ODC model), so the facade hands the ODC bridge two merges whose
    /// own plan is empty: first the candidate without the deferred defaults (it creates the elements), then the candidate
    /// over the module captured after it (the defaults land on existing elements). The bridge's NativeMergeOrder.Prepare
    /// then never builds its first-pass copy inside the Studio (its transaction throws in ODC Studio 1.7.27, 2026-10-08).
    /// -> {rule, deferred[], firstPass: path|null, firstPassSha256}. Never overwrites.</summary>
    private static object MergeOrderPlan(string[] args)
    {
        var basePath = Path.GetFullPath(Need(args, "--base"));
        var candidatePath = Path.GetFullPath(Need(args, "--candidate"));
        var outPath = Path.GetFullPath(Need(args, "--out"));
        if (File.Exists(outPath)) throw new IOException("a saida ja existe (merge-order nunca sobrescreve): " + outPath);
        var host = Host(args);
        var plan = new MergePlanner(_ => host).Plan(basePath, candidatePath, outPath);
        plan["firstPassSha256"] = plan["firstPass"] == null ? null
            : Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(outPath))).ToLowerInvariant();
        Log($"merge-order: {plan["deferred"]!.AsArray().Count} deferred default(s)");
        return plan;
    }

    private static object Inspect(string[] args)
    {
        // A listing the module index answers exactly comes from the stored index of these bytes, before Host binds the
        // ODC Studio; otherwise the model answers, as before, and stores the index.
        if (Anvil.Reading.ReadingOptions.Requested(args))
            return IndexedInspect(args) ?? Host(args).ReadModel(Need(args, "--oml"), Opt(args, "--path") ?? "/", Anvil.Reading.ReadingOptions.Parse(args),
                Anvil.Reading.ModuleIndexStore.Default());
        var snap = Host(args).Inspect(Need(args, "--oml"));
        Log($"{snap.Name} ({snap.Kind}): {snap.Objects} objects, {snap.References.Count} references, {snap.Validation.Total} messages, load {snap.LoadMs} ms");
        return snap;
    }

    // `read-serve --state <f> --generation <g> [--work <dir>]`: the resident read-only reader (reader-client.mjs) over the
    // kernel's ODC reader, as `anvil read-serve` on O11. The facade asks it for the module digest (ssam_map view:"digest"):
    // the builder's reader sees the public Model API, where widgets read as Content trees the digest does not render.
    private static object ReadServe(string[] args)
    {
        StudioAssembliesOdc.Bind(null);
        return KernelSnapshotReading.Serve(Need(args, "--state"), Need(args, "--generation"), Opt(args, "--work") ?? Path.Combine(Path.GetTempPath(), "anvil-odc-reading"));
    }

    // `ddl --oml <capture> [--out <file>]`: the data text (ssam-ddl/1) of the capture, from the store beside its module index,
    // else built from the model and stored; --out writes the text. `ddl --oml <capture> --check [--out <file>]`: its fixed
    // point (print, parse, compare with the model; DdlCheck), never stored; --out writes the report.
    private static object Ddl(string[] args)
    {
        if (args.Contains("--merge-battery")) {
            // The three-way merge of the data text: a Studio edit and a model edit of the same read, merged (DdlMergeBattery).
            var lane = Anvil.Reading.ModuleIndexStore.Default()?.Lane ?? "odc";
            var seed = int.TryParse(Opt(args, "--seed"), out var s) ? s : 1;
            var rounds = int.TryParse(Opt(args, "--rounds"), out var r) ? r : 2;
            var (total, modules) = Opt(args, "--manifest") is { } list
                ? DdlMergeBattery.RunManifest(Host(args), list, lane, seed, rounds, Log, Opt(args, "--only"))
                : (DdlMergeBattery.Run(Host(args), Need(args, "--oml"), lane, seed, rounds, Log), new System.Text.Json.Nodes.JsonArray());
            var report = total.ToJson(); report["lane"] = lane; report["modules"] = modules;
            if (Opt(args, "--out") is { } reportFile) File.WriteAllText(reportFile, report.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
            Log("ddl merge battery: " + total.Exact + " of " + total.Cases + " cases exact (disjoint " + total.DisjointExact + "/" + total.Disjoint + ", overlapping " + total.OverlapExact + "/" + total.Overlap + ")");
            return report;
        }
        if (args.Contains("--battery")) {
            // DL2: edits of the data text applied back to the module, which must read back as the edited text (DdlBattery).
            var lane = Anvil.Reading.ModuleIndexStore.Default()?.Lane ?? "odc";
            var edits = int.TryParse(Opt(args, "--edits"), out var e) ? e : 0;
            var seed = int.TryParse(Opt(args, "--seed"), out var s) ? s : 11;
            var (total, modules) = Opt(args, "--manifest") is { } list
                ? DdlBattery.RunManifest(Host(args), list, lane, edits, seed, Log, Opt(args, "--only"))
                : (DdlBattery.Run(Host(args), Need(args, "--oml"), lane, edits > 0 ? edits : 24, seed, log: Log), new System.Text.Json.Nodes.JsonArray());
            var report = total.ToJson(); report["lane"] = lane; report["modules"] = modules;
            if (Opt(args, "--out") is { } reportFile) File.WriteAllText(reportFile, report.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
            Log("ddl battery: " + total.Exact + " of " + total.Edits + " edits back equal, " + total.Failures.Count + " failing batches");
            return report;
        }
        if (args.Contains("--check") && Opt(args, "--manifest") is { } manifest) {
            // Every capture of this lane the manifest lists ([{label, lane, oml}], the fixed-point corpus): one report.
            var lane = Anvil.Reading.ModuleIndexStore.Default()?.Lane ?? "odc";
            var modules = new System.Text.Json.Nodes.JsonArray(); int elements = 0, exact = 0, differences = 0;
            foreach (var entry in System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(manifest))!.AsArray()) {
                if (entry!["lane"]?.ToString() != lane) continue;
                var oml = entry["oml"]!.ToString();
                if (!File.Exists(oml)) { modules.Add(new System.Text.Json.Nodes.JsonObject { ["label"] = entry["label"]?.ToString(), ["missing"] = oml }); continue; }
                var one = Host(args).CheckDdl(File.ReadAllBytes(oml), lane).ToJson(int.TryParse(Opt(args, "--samples"), out var n) ? n : 40);
                one["label"] = entry["label"]?.ToString();
                elements += one["elements"]!.GetValue<int>(); exact += one["exact"]!.GetValue<int>(); differences += one["mismatches"]!.GetValue<int>();
                Log("ddl check " + one["label"] + ": " + one["exact"] + " of " + one["elements"] + " exact, " + one["mismatches"] + " differences" + (one["parseError"] is { } e ? ", parse error " + e : ""));
                modules.Add(one);
            }
            var batch = new System.Text.Json.Nodes.JsonObject { ["lane"] = lane, ["elements"] = elements, ["exact"] = exact, ["differences"] = differences, ["modules"] = modules };
            if (Opt(args, "--out") is { } batchFile) File.WriteAllText(batchFile, batch.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
            return new System.Text.Json.Nodes.JsonObject { ["lane"] = lane, ["elements"] = elements, ["exact"] = exact, ["differences"] = differences, ["modules"] = modules.Count };
        }
        if (args.Contains("--check")) {
            var report = Host(args).CheckDdl(File.ReadAllBytes(Need(args, "--oml")), Anvil.Reading.ModuleIndexStore.Default()?.Lane ?? "odc").ToJson(int.TryParse(Opt(args, "--samples"), out var samples) ? samples : 40);
            if (Opt(args, "--out") is { } reportFile) File.WriteAllText(reportFile, report.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
            Log("ddl check: " + report["exact"] + " of " + report["elements"] + " elements exact, " + report["mismatches"] + " differences" + (report["parseError"] is { } error ? ", parse error " + error : ""));
            return report;
        }
        var store = Anvil.Reading.ModuleIndexStore.Default()
            ?? throw new InvalidOperationException("No module index store: set SSAM_MODULE_INDEX_ROOT or run inside an SSAM workspace");
        var answer = Anvil.Reading.DataDdl.Ensure(store, Need(args, "--oml"), (bytes, sha) => Host(args).BuildDdl(bytes, sha, store.Lane));
        if (Opt(args, "--out") is { } outFile) {
            File.WriteAllText(outFile, store.LoadDdl(answer["sourceSha256"]!.ToString())!.Text);
            answer["out"] = Path.GetFullPath(outFile);
        }
        Log("ddl: " + answer["bytes"] + " bytes, " + answer["elements"] + " elements, " + (answer["built"]!.GetValue<bool>() ? "built" : "stored") + " " + answer["path"]);
        return answer;
    }

    /// <summary>`flow --oml &lt;capture&gt; [--action &lt;name|@key&gt;] [--out &lt;file&gt;]`: the flow reading (ssam-flow/1) of
    /// the capture, from the store beside its module index, else built from the model and stored. Answers its counts and
    /// fixed point; --action answers one action's text and ids; --out writes every action's text (or the one asked).</summary>
    private static object Flow(string[] args)
    {
        var store = Anvil.Reading.ModuleIndexStore.Default()
            ?? throw new InvalidOperationException("No module index store: set SSAM_MODULE_INDEX_ROOT or run inside an SSAM workspace");
        var (flow, path, built) = Anvil.Reading.ModuleFlow.Ensure(store, Need(args, "--oml"), (bytes, sha) => Host(args).BuildFlow(bytes, sha, store.Lane));
        var answer = flow.Answer(path, built);
        var selected = flow.Actions.ToList();
        if (Opt(args, "--action") is { } wanted) {
            selected = flow.Actions.Where(a => a.Key == wanted.TrimStart('@') || a.Name == wanted || a.Name.EndsWith("/" + wanted, StringComparison.Ordinal)).ToList();
            if (selected.Count == 0) throw new ArgumentException("no action " + wanted + " in this capture");
            answer["selected"] = new System.Text.Json.Nodes.JsonArray(selected.Select(a => (System.Text.Json.Nodes.JsonNode)new System.Text.Json.Nodes.JsonObject {
                ["key"] = a.Key, ["kind"] = a.Kind, ["name"] = a.Name, ["fixedPoint"] = a.FixedPoint, ["textSha"] = a.TextSha, ["text"] = a.Text,
                ["opaque"] = a.Opaque is { Count: > 0 } opaque ? new System.Text.Json.Nodes.JsonArray(opaque.Select(o => (System.Text.Json.Nodes.JsonNode)o).ToArray()) : null,
                ["ids"] = new System.Text.Json.Nodes.JsonObject(a.Ids.Select(p => KeyValuePair.Create(p.Key, (System.Text.Json.Nodes.JsonNode?)p.Value))),
                ["problems"] = new System.Text.Json.Nodes.JsonArray(a.Problems.Select(p => (System.Text.Json.Nodes.JsonNode)p).ToArray()) }).ToArray());
            // The read of each action served, kept as ssam_map view flow keeps it: an edit of it is merged three ways (FlowMerge).
            foreach (var action in selected.Where(a => a.FixedPoint)) store.SaveFlowReading(Anvil.Reading.FlowReading.Of(action, store.Lane, flow.SourceSha256));
        }
        if (Opt(args, "--out") is { } outFile) {
            File.WriteAllText(outFile, string.Concat(selected.Select(a => a.Text + "\n")));
            answer["out"] = Path.GetFullPath(outFile);
        }
        Log("flow: " + answer["actions"] + " actions, " + answer["fixedPoint"] + " fixed points, " + (built ? "built" : "stored") + " " + path);
        return answer;
    }

    /// <summary>`flow-battery --oml &lt;capture&gt; [--every N] [--seed S] [--kinds expression,call,...]`: the LG2 battery over one
    /// module (FlowBattery): synthetic edits of its actions written back through the logic op's text form and read again.</summary>
    private static object FlowBatteryCmd(string[] args)
    {
        var file = Need(args, "--oml");
        var tally = Anvil.Core.FlowBattery.Run(Host(args), File.ReadAllBytes(file), Path.GetFileNameWithoutExtension(file),
            int.TryParse(Opt(args, "--seed"), out var seed) ? seed : 1, int.TryParse(Opt(args, "--every"), out var every) ? every : 1,
            Opt(args, "--kinds")?.Split(','), Log);
        Log("flow-battery: " + tally.Edits + " edits, " + tally.Exact + " exact, " + tally.Reverts + " undone, " + tally.RevertsExact + " exact");
        return tally.ToJson();
    }

    /// <summary>`flow-merge-battery --oml &lt;capture&gt; [--every N] [--seed S] [--disjoint N]`: the battery of the three-way merge of
    /// the logic text over one module (FlowMergeBattery): a Studio edit and a model edit of the same read, disjoint and
    /// overlapping, merged, written and read again.</summary>
    private static object FlowMergeBatteryCmd(string[] args)
    {
        var file = Need(args, "--oml");
        var tally = Anvil.Core.FlowMergeBattery.Run(Host(args), File.ReadAllBytes(file), Path.GetFileNameWithoutExtension(file), "odc",
            int.TryParse(Opt(args, "--seed"), out var seed) ? seed : 1, int.TryParse(Opt(args, "--every"), out var every) ? every : 1,
            int.TryParse(Opt(args, "--disjoint"), out var disjoint) ? disjoint : 2, Log);
        Log("flow-merge-battery: " + tally.Cases + " cases, " + tally.Exact + " exact (disjoint " + tally.DisjointExact + "/" + tally.Disjoint + ", overlapping " + tally.OverlapExact + "/" + tally.Overlap + ")");
        return tally.ToJson();
    }

    /// <summary>`flow-create-battery --oml &lt;capture&gt; [--every N] [--seed S]`: the creation battery over one module
    /// (FlowCreateBattery): screen and data actions born from texts without @key whose header names their screen or block.</summary>
    private static object FlowCreateBatteryCmd(string[] args)
    {
        var file = Need(args, "--oml");
        var tally = Anvil.Core.FlowCreateBattery.Run(Host(args), File.ReadAllBytes(file), Path.GetFileNameWithoutExtension(file),
            int.TryParse(Opt(args, "--seed"), out var seed) ? seed : 1, int.TryParse(Opt(args, "--every"), out var every) ? every : 1, Log);
        Log("flow-create-battery: " + tally.Created + " created, " + tally.Exact + " exact, " + tally.Traditional + " Traditional owners");
        return tally.ToJson();
    }

    // `digest --oml <capture> [--out <file.txt>]`: the module digest (ssam-digest) of the capture, from the store beside its
    // module index (a hit binds no ODC Studio), else built from the model and stored; --out writes the text.
    private static object Digest(string[] args)
    {
        var store = Anvil.Reading.ModuleIndexStore.Default()
            ?? throw new InvalidOperationException("No module index store: set SSAM_MODULE_INDEX_ROOT or run inside an SSAM workspace");
        var answer = Anvil.Reading.ModuleDigest.Ensure(store, Need(args, "--oml"), (bytes, sha) => Host(args).BuildDigest(bytes, sha, store.Lane));
        if (Opt(args, "--out") is { } outFile) {
            File.WriteAllText(outFile, store.LoadDigest(answer["sourceSha256"]!.ToString())!.Text);
            answer["out"] = Path.GetFullPath(outFile);
        }
        Log("digest: " + answer["bytes"] + " bytes, " + answer["tokens"] + " tokens, " + (answer["built"]!.GetValue<bool>() ? "built" : "stored") + " " + answer["path"]);
        return answer;
    }

    /// <summary>`html-read --oml &lt;capture&gt; [--path &lt;screen|Kind:Name|@key&gt;] [--out &lt;file.html&gt;] [--explain &lt;name&gt;]`: the screen or block as
    /// ssam-html/1 (Anvil.Reading.ScreenHtml), with its keys; without --path every screen and block.</summary>
    private static object HtmlRead(string[] args)
    {
        var answer = Host(args).HtmlRead(File.ReadAllBytes(Need(args, "--oml")), Opt(args, "--path"), explain: Opt(args, "--explain"));
        if (Opt(args, "--out") is { } outFile && answer["documents"]!.AsArray() is [var single]) {
            File.WriteAllText(outFile, single!["html"]!.GetValue<string>());
            answer["out"] = Path.GetFullPath(outFile);
        }
        return answer;
    }

    /// <summary>`html-edit --oml &lt;capture&gt; --data &lt;data.json&gt; [--out &lt;result.oml&gt;]`: one html op in its edit form
    /// ({screen, basedOn, edit|html}, C2 of the plan "Texto do SSAM") applied to the capture, as a job applies it.</summary>
    private static object HtmlEdit(string[] args)
    {
        var data = System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(Need(args, "--data")))!.AsObject();
        return Host(args).HtmlEdit(File.ReadAllBytes(Need(args, "--oml")), data["data"] as System.Text.Json.Nodes.JsonObject ?? data, Opt(args, "--out"));
    }

    /// <summary>`html-edit-battery --oml &lt;capture&gt; [--seed N] [--per-kind N] [--root Name] [--out report.json]`: the synthetic
    /// edits of every screen and block of the capture (C2 acceptance), each applied and rolled back.</summary>
    private static object HtmlEditBattery(string[] args)
    {
        var report = Host(args).HtmlEditBattery(File.ReadAllBytes(Need(args, "--oml")), int.Parse(Opt(args, "--seed") ?? "1"), int.Parse(Opt(args, "--per-kind") ?? "1"),
            line => Console.Error.WriteLine(line), Opt(args, "--root"));
        if (Opt(args, "--out") is { } outFile) {
            File.WriteAllText(outFile, report.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
            return new { edits = report["edits"]!.GetValue<int>(), ok = report["ok"]!.GetValue<int>(), kinds = report["kinds"]!.ToJsonString(), @out = Path.GetFullPath(outFile) };
        }
        return report;
    }

    /// <summary>`html-recreate --oml &lt;capture&gt; [--path &lt;screen&gt;] [--blocks] [--verify] [--out &lt;report.json&gt;]`: the
    /// recreation proof of the document form (B1): every screen (and, with --blocks, block) read by ssam-html/1 is compiled
    /// again in the loaded copy without it and read back (same text, keys mapped), with --verify the Verify of each step.
    /// Nothing is saved.</summary>
    private static object HtmlRecreate(string[] args)
    {
        var report = Anvil.Core.ScreenRecreationProof.Run(Host(args), File.ReadAllBytes(Need(args, "--oml")), Opt(args, "--path"), args.Contains("--blocks"), args.Contains("--verify"), Log);
        if (Opt(args, "--out") is { } outFile) { File.WriteAllText(outFile, report.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true })); return new { roots = report["roots"]!.GetValue<int>(), outcomes = report["outcomes"]!.ToJsonString(), @out = Path.GetFullPath(outFile) }; }
        return report;
    }

    /// <summary>`html-check --oml &lt;capture&gt; [--html-dir &lt;dir&gt;] [--out &lt;report.json&gt;]`: the fixed point of the
    /// ssam-html/1 reading over every screen and block (read, parse back, compare: no difference), with sizes and times.</summary>
    private static object HtmlCheck(string[] args)
    {
        var report = Host(args).HtmlCheck(File.ReadAllBytes(Need(args, "--oml")), Opt(args, "--html-dir"));
        if (Opt(args, "--out") is { } outFile) { File.WriteAllText(outFile, report.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true })); return new { documents = report["documents"]!.AsArray().Count, @out = Path.GetFullPath(outFile) }; }
        return report;
    }

    /// <summary>`html-census --oml &lt;capture&gt; [--out &lt;file.json&gt;]`: every property and child kind of the screens and
    /// blocks of the capture (Anvil.Reading.ScreenHtmlCensus), to measure the ssam-html/1 tables.</summary>
    private static object HtmlCensus(string[] args)
    {
        var census = Host(args).HtmlCensus(File.ReadAllBytes(Need(args, "--oml")));
        if (Opt(args, "--out") is { } outFile) { File.WriteAllText(outFile, census.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true })); return new { kinds = census.Count, @out = Path.GetFullPath(outFile) }; }
        return census;
    }

    // `rich-index --oml <capture>`: the rich module index (ssam-rich-index) of the capture, from the store beside its module
    // index (a hit binds no ODC Studio), else built from the model and stored.
    private static object RichIndex(string[] args)
    {
        var store = Anvil.Reading.ModuleIndexStore.Default()
            ?? throw new InvalidOperationException("No module index store: set SSAM_MODULE_INDEX_ROOT or run inside an SSAM workspace");
        var answer = Anvil.Reading.ModuleRichIndex.Ensure(store, Need(args, "--oml"), (bytes, sha) => Host(args).BuildRich(bytes, sha, store.Lane));
        Log("rich-index: " + answer["bytes"] + " bytes, " + answer["counts"]!["elements"] + " elements, " + (answer["built"]!.GetValue<bool>() ? "built" : "stored") + " " + answer["path"]);
        return answer;
    }
    private static JsonObject? IndexedInspect(string[] args)
    {
        try
        {
            if (Opt(args, "--oml") is not { } oml) return null;
            var data = Anvil.Reading.ModuleIndex.ReadStored(Anvil.Reading.ModuleIndexStore.Default(), oml, Opt(args, "--path") ?? "/", Anvil.Reading.ReadingOptions.Parse(args));
            if (data != null) Log("module index: answered from the stored index of " + data["sourceSha256"]);
            return data;
        }
        catch { return null; } // the model path reports the same input errors
    }

    /// <summary>`census --oml &lt;ficheiro&gt;`: o censo COMPLETO do modulo, por tipo do Model API -- quantas instancias,
    /// que propriedades o codigo de facto define, e que filhos uma instancia real tem. O `inspect` devolve o top-N dos
    /// tipos; isto percorre tudo. E a leitura que ensina a CRIAR: a API diz o que e possivel, um modulo real diz o que
    /// e usado. Guarda forma, nao conteudo (texto entra como estatistica de tamanho; valores distintos so de enum e
    /// booleano), por isso o censo de um modulo de terceiro pode ser lido e discutido sem carregar codigo dele.</summary>
    private static object Census(string[] args)
    {
        var oml = Need(args, "--oml");
        var census = Host(args).Census(oml);
        Log($"{Path.GetFileNameWithoutExtension(oml)}: {census["objects"]} objects in {census["types"]} types");
        if (Opt(args, "--out") is not { } outPath) return census;
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outPath))!);
        File.WriteAllText(outPath, census.ToJsonString(Json.Pretty));
        return new { oml, outPath, objects = census["objects"]?.GetValue<int>(), types = census["types"]?.GetValue<int>() };
    }

    /// <summary>`api --op native --type &lt;Interface&gt;`: o contrato do tipo tal como esta carregado nesta instalacao
    /// (reflexao sobre os assemblies do Studio), partilhado com a faixa O11 (NativeSurface).</summary>
    private static object Native(string[] args)
    {
        StudioAssembliesOdc.Bind(null);
        return NativeSurface.Describe(Need(args, "--type"));
    }

    private static object VerifyCatalogCmd(string[] args)
    {
        // O adaptador se descobre por reflexao sobre os tipos do assembly: ligar a instalacao ANTES de o tocar.
        StudioAssembliesOdc.Bind(null);
        var all = StudioAdapter.Runtime.VerifyDefinitions;
        // `--out catalog/odc/verify-messages-<versao>.json`: a LISTA DE IDS do ODC Studio instalado, o manifesto contra o
        // qual os jobs desta faixa declaram expectedMessages (MessageExpectations). So o id, como na faixa O11.
        if (Opt(args, "--out") is { } outPath)
        {
            var ids = all.Select(d => d.Id).Order(StringComparer.Ordinal).ToList();
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outPath))!);
            File.WriteAllText(outPath, System.Text.Json.JsonSerializer.Serialize(ids.Select(i => new { id = i }), new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
            return new { wrote = outPath, ideVersion = StudioAdapter.Runtime.IdeVersion, count = ids.Count };
        }
        if (Opt(args, "--id") is not { } id)
            return new { platform = StudioAdapter.Runtime.Platform, ideVersion = StudioAdapter.Runtime.IdeVersion, count = all.Count, definitions = all };
        var found = all.FirstOrDefault(d => string.Equals(d.Id, id, StringComparison.OrdinalIgnoreCase));
        return found is null ? new { notFound = id, count = all.Count } : (object)found;
    }

    private static object Deliver(string[] args)
    {
        StudioAssembliesOdc.Bind(null);
        var evidence = Path.GetFullPath(Need(args, "--evidence"));
        var owners = Need(args, "--owners").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var result = new StudioSessionOdc(new BridgeClientOdc())
            .DeliverJob(Need(args, "--module"), Need(args, "--job"), evidence, Need(args, "--feature"), owners, new[] { Need(args, "--change") }, Log);
        File.WriteAllText(Path.Combine(evidence, "deliver-result.json"), result.ToJsonString(Json.Pretty));
        return result;
    }

    private static object Publish(string[] args)
    {
        // A autorizacao e o texto que o dono escreveu; sem ele o comando recusa aqui, antes do bridge.
        var authorization = Opt(args, "--authorization");
        if (string.IsNullOrWhiteSpace(authorization))
            return new JsonObject { ["ok"] = false, ["error"] = "publish exige --authorization \"<texto escrito pelo dono>\"; nunca e inventado" };
        return new PublisherOdc(new BridgeClientOdc()).Publish(Need(args, "--manifest"), authorization).ToJson();
    }

    private static object Gc()
    {
        var before = GC.GetTotalMemory(false) >> 20;
        GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
        return new { beforeMB = before, afterMB = GC.GetTotalMemory(true) >> 20, workingSetMB = Environment.WorkingSet >> 20, served = _served };
    }

    /// <summary>
    /// Worker residente da faixa ODC: `serve --port 4547`. Recebe por TCP loopback uma linha
    /// <c>{"args":["apply","--job",...],"authorization":"&lt;credencial&gt;"}</c>, roda o MESMO Dispatch em processo (DLLs do
    /// ODC Studio ja ligadas, feature provider inicializado, JIT quente) e devolve o mesmo envelope numa linha. Um pedido
    /// de cada vez. Sem isto, cada job paga ~4 s so para carregar o modulo; com isto, paga uma vez por processo.
    /// Com a fila vazia, o worker carrega e percorre uma instancia NOVA da ultima base usada (BaseModelCache, como na faixa
    /// O11), que o proximo apply da mesma base toma uma vez e liberta como sempre: o load sai do caminho do pedido.
    /// A credencial e a mesma do worker da faixa O11 (BridgeAccess), porque e a mesma maquina e o mesmo dono.
    /// </summary>
    private static void Serve(string[] args)
    {
        var port = int.TryParse(Opt(args, "--port"), out var p) ? p : 4547;
        Anvil.Core.Delivery.BridgeAccess.Initialize();
        var credential = Anvil.Core.Delivery.BridgeAccess.ReadCredential();
        var limit = int.TryParse(Environment.GetEnvironmentVariable("ANVIL_ODC_WORKER_MAX_COMMANDS"), out var n) && n > 0 ? n : 2000;
        var logDir = Path.GetFullPath(Opt(args, "--log-dir") ?? Path.Combine(".local", "lane-odc")); Directory.CreateDirectory(logDir);
        var oldError = Console.Error;
        using var file = new StreamWriter(Path.Combine(logDir, $"worker-odc-{port}-{Environment.ProcessId}.log"), append: true) { AutoFlush = true };
        Console.SetError(TextWriter.Synchronized(file));
        try
        {
            // Ligar a instalacao e subir o runtime UMA vez, antes do primeiro pedido: e esse o ganho do worker.
            StudioAssembliesOdc.Bind(null);
            StudioAdapter.Runtime.Ensure(Path.Combine(logDir, "work"));
            Log($"anvil-odc worker: ODC Studio {StudioAssembliesOdc.IdeVersion} em {StudioAssembliesOdc.Directory}");
            BaseModelCache.Enable(Log);
            JsonObject Metrics() => new() { ["baseCache"] = BaseModelCache.Stats() };
            using var server = new WorkerServer(port, argv =>
            {
                var sw = Stopwatch.StartNew(); var command = argv[0];
                try
                {
                    if (command == "serve") throw new InvalidOperationException("serve nao e comando de worker");
                    var data = Dispatch(command, argv);
                    return data == null ? ErrorEnvelope(command, new ArgumentException("comando desconhecido: " + command), sw.ElapsedMilliseconds)
                        : Envelope(command, data, sw.ElapsedMilliseconds);
                }
                catch (Exception ex) { Log(ex.ToString()); return ErrorEnvelope(command, ex, sw.ElapsedMilliseconds); }
                finally { Interlocked.Increment(ref _served); }
            }, limit, log: Log, commandMetrics: Metrics,
                initialMetrics: new JsonObject { ["studio"] = StudioAssembliesOdc.Directory, ["platform"] = "odc", ["authenticatedWorker"] = true,
                    ["baseCache"] = BaseModelCache.Stats(),
                    // B2 (C02): what a delivery's apply needs from a worker. A worker without them (an older CLI) would stamp its
                    // own identity, so the facade runs such a delivery cold.
                    ["capabilities"] = new JsonArray("apply:developer-id", "apply:base-content-sha256", "merge-order") },
                authorize: request => Anvil.Core.Delivery.BridgeAccess.Matches(request["authorization"]?.ToString(), credential),
                idle: BaseModelCache.Worker);
            Log($"anvil-odc worker: ouvindo em 127.0.0.1:{port} pid {Environment.ProcessId}");
            server.RunAsync().GetAwaiter().GetResult();
        }
        finally { Console.SetError(oldError); }
    }

    // ---- envelope e utilitarios -------------------------------------------------------------------------

    /// <summary>O mesmo envelope da faixa O11, para que o cliente leia as duas faixas do mesmo jeito.</summary>
    private static JsonObject Envelope(string command, object data, long ms)
    {
        var node = data as JsonNode ?? JsonNode.Parse(Json.Serialize(data));
        var ok = command switch
        {
            "apply" => node?["accepted"]?.GetValue<bool>() == true,
            "check-job" => node?["valid"]?.GetValue<bool>() == true,
            "deliver" => node?["delivered"]?.GetValue<bool>() == true,
            "merge" or "publish" or "status" or "snapshot" or "refresh" or "external-library" => node?["ok"]?.GetValue<bool>() != false,
            _ => true,
        };
        return new JsonObject { ["ok"] = ok, ["command"] = command, ["elapsedMs"] = ms, ["data"] = node };
    }

    // The same envelope as the O11 lane, with code and problems when the exception carries them (PREFLIGHT_REFUSED).
    private static JsonObject ErrorEnvelope(string command, Exception ex, long ms) => Errors.Envelope(command, ex, ms);

    private static ModelHost Host(string[] args)
    {
        StudioAssembliesOdc.Bind(null);
        return new ModelHost(Opt(args, "--work") ?? Path.Combine(Path.GetTempPath(), "anvil-odc-work"));
    }

    private static string? Opt(string[] args, string name) { var i = Array.IndexOf(args, name); return i >= 0 && i + 1 < args.Length ? args[i + 1] : null; }
    private static string Need(string[] args, string name) => Opt(args, name) ?? throw new ArgumentException("falta " + name);
    private static void Log(string line) => Console.Error.WriteLine(line);
    private static void Emit(JsonObject o) => Console.Out.WriteLine(o.ToJsonString(Json.Pretty));
}
