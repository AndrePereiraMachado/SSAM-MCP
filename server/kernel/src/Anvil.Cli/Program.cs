// SSHeadless CLI. Cada subcomando chama a biblioteca e imprime UM JSON:
//   { "ok": bool, "command": str, "elapsedMs": n, "data": {...} | "error": str }
//
//   inventory     --credentials <json> [--host h] [--out dir]        apps + modulos + catalogos
//   download      --credentials <json> --module <nome|key> --out dir [--version n]
//   download-all  --credentials <json> --out dir [--filter substr]
//   download-app  --credentials <json> --app <nome|key>[,<nome|key>...] --out dir
//   referenceable --credentials <json>                                  catalogo de produtores do servidor
//   data          --module <nome> --oml <snapshot> --request <json>      Edit Data pelo login do Studio (ver DataCommand)
//   data          --host h --module <nome> --oml <snapshot> --request <json>   Edit Data pela credencial privada do host
//   references    --oml <arquivo> [--work dir]                          referencias consumidas (do OML)
//   inspect       --oml <arquivo> [--work dir]                          load + verify + objetos + referencias
//   roundtrip     --oml <arquivo> --out dir [--work dir]                load -> save -> reload -> compare
//   apply         --job <json> --out <oml> [--base <snapshot>] [--producer Name=oml]                 job de verbos (ops, ou composto: jobs)
//   functions     [--out <json>] [--docs <md>] | --find <substr> | --name <Funcao>   funcoes built-in do Studio
//   xif           check|read|build --stage model|final|diff              extensoes .NET O11 sem Integration Studio (XifCommand)
//
// Segredos: lidos do arquivo, nunca impressos. --studio-dir troca a instalacao (default Anvil 4516).
using System.Diagnostics;
using System.Text.Json.Nodes;
using Anvil.Core;

namespace Anvil.Cli;

public static class Program
{
    public static int Main(string[] args)
    {
        var sw = Stopwatch.StartNew();
        var command = args.Length > 0 ? args[0] : "help";
        try
        {
            if (command == "inspect" && IndexedInspect(args) is { } indexed)
            {
                var answered = Envelope(command, indexed, sw.ElapsedMilliseconds);
                Emit(answered);
                return 0;
            }
            if (command is not ("check-job" or "check-delivery" or "api" or "recipe" or "app-session" or "--version" or "xif")) StudioAssemblies.Bind(Opt(args, "--ss-dir"));
            // primeira-certa A1: check-job judges the properties of the job's sets against the Model API (PropertyRules) when a
            // Studio is installed; unbound, that rule was skipped and its problems came one round later, from apply.
            else if (command == "check-job") { try { StudioAssemblies.Bind(Opt(args, "--ss-dir")); } catch { /* no Studio here: the rule stays a warning */ } }
            var data = Dispatch(command, args);
            if (data == null)
            {
                Console.Error.WriteLine("usage: anvil <inventory|download|download-all|download-app|referenceable|references|inspect|roundtrip|apply|deliver|check-job|functions|verify-message|where-can|recipe|api|serve> ...");
                return 64;
            }
            var envelope = Envelope(command, data, sw.ElapsedMilliseconds);
            Emit(envelope);
            return envelope["ok"]!.GetValue<bool>() ? 0 : 1;
        }
        catch (Exception ex)
        {
            if (command == "publish-oml")
            {
                Emit(new JsonObject { ["ok"] = false, ["command"] = command,
                    ["error"] = "publish_oml_runtime_unavailable", ["elapsedMs"] = sw.ElapsedMilliseconds });
                return 1;
            }
            Log(ex.ToString());
            Emit(ErrorEnvelope(command, ex, sw.ElapsedMilliseconds));
            return 1;
        }
    }

    private static JsonObject Envelope(string command, object data, long ms)
    {
        var node = JsonNode.Parse(Json.Serialize(data));
        return new() { ["ok"] = command is "create-app" or "add-modules" ? (node?["Succeeded"] ?? node?["succeeded"])?.GetValue<bool>() == true : command == "deliver" ? node?["delivered"]?.GetValue<bool>() == true || node?["closed"]?.GetValue<bool>() == true : command == "check-delivery" ? node?["accepted"]?.GetValue<bool>() == true : command is "access" or "data" or "users" or "publish-oml" or "xif" ? node?["ok"]?.GetValue<bool>() == true : command != "check-job" || node?["valid"]?.GetValue<bool>() == true,
            ["command"] = command, ["elapsedMs"] = ms, ["data"] = node };
    }

    private static JsonObject ErrorEnvelope(string command, Exception ex, long ms)
    {
        // a mensagem mais exterior que ainda contem a raiz (traz o prefixo "op #i (verbo ...)" de Verbs.Apply); tipo = o da raiz;
        // code e problems quando a excecao os carrega (PREFLIGHT_REFUSED com todos os problemas)
        return Errors.Envelope(command, ex, ms);
    }

    private static int _served;

    /// <summary>Coleta completa e memoria antes/depois: distingue lixo por recolher (desce) de fuga real (nao desce).</summary>
    private static object Gc()
    {
        var before = GC.GetTotalMemory(false) >> 20;
        GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
        return new { beforeMB = before, afterMB = GC.GetTotalMemory(true) >> 20, workingSetMB = Environment.WorkingSet >> 20, served = _served, loadedModules = RetainedModules(ModelHost.LoadedModules().Count) };
    }

    /// <summary>Modulos registados menos as bases de reserva do worker (BaseModelCache): essas estao seguras de proposito e
    /// sao libertadas quando saem do cache, por isso nao contam como fuga.</summary>
    private static int RetainedModules(int loaded) => loaded < 0 ? loaded : loaded - BaseModelCache.Held;

    /// <summary>Diagnostico da segunda raiz de memoria: colecoes em campos ESTATICOS dos assemblies do Studio e do Anvil com o
    /// tamanho atual. Chamado antes e depois de N pedidos, mostra o que cresce por pedido. --min N filtra tamanhos pequenos.</summary>
    private static object Statics(string[] args)
    {
        var min = int.TryParse(Opt(args, "--min"), out var m) ? m : 1;
        var rows = new List<(string Name, long Count)>();
        var scanned = 0; var typesSeen = 0;
        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            var an = asm.GetName().Name ?? "";
            if (!(an.StartsWith("ServiceStudio", StringComparison.Ordinal) || an.StartsWith("OutSystems", StringComparison.Ordinal) || an.StartsWith("Anvil", StringComparison.Ordinal))) continue;
            Type[] types;
            try { types = asm.GetTypes(); } catch (System.Reflection.ReflectionTypeLoadException ex) { types = ex.Types.Where(t => t != null).Cast<Type>().ToArray(); }
            foreach (var t in types)
            {
                if (t.IsGenericTypeDefinition) continue;
                typesSeen++;
                System.Reflection.FieldInfo[] fields;
                try { fields = t.GetFields(System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.DeclaredOnly); } catch { continue; }
                foreach (var f in fields)
                {
                    if (f.IsLiteral) continue;
                    object? v;
                    try { v = f.GetValue(null); } catch { continue; }
                    scanned++;
                    long c = -1;
                    if (v is Delegate del) c = del.GetInvocationList().Length;   // eventos estaticos: lista de invocacao segura os alvos (closures) com forca
                    else if (v is System.Collections.ICollection col) c = col.Count;
                    else if (v is System.Collections.IDictionary dic) c = dic.Count;
                    else if (v != null)
                    {
                        var cp = v.GetType().GetProperty("Count");
                        if (cp != null && cp.PropertyType == typeof(int)) { try { c = (int)cp.GetValue(v)!; } catch { c = -1; } }
                    }
                    if (c >= min) rows.Add((t.FullName + "." + f.Name, c));
                }
            }
        }
        return new { typesSeen, scanned, entries = rows.Count, heapMB = GC.GetTotalMemory(false) >> 20, served = _served,
            top = rows.OrderByDescending(r => r.Count).Take(int.TryParse(Opt(args, "--top"), out var tp) && tp > 0 ? tp : int.MaxValue).Select(r => new { r.Name, r.Count }).ToList() };
    }

    /// <summary>O que o processo retem: modulos ainda registados no Studio (ESpaceInstances) e memoria antes/depois de um GC completo.</summary>
    private static object Leak()
    {
        var (count, names) = ModelHost.LoadedModules();
        var retained = RetainedModules(count);
        var before = GC.GetTotalMemory(false) >> 20;
        GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
        var after = GC.GetTotalMemory(true) >> 20;
        var byName = names.GroupBy(n => n).OrderByDescending(g => g.Count()).ToDictionary(g => g.Key, g => g.Count());
        return new { loadedModules = retained, cachedModules = BaseModelCache.Held, byName, heapBeforeMB = before, heapAfterGcMB = after, workingSetMB = Environment.WorkingSet >> 20, served = _served,
            verdict = retained > 1 ? "FUGA: modulos retidos pelo registo estatico do Studio (falta ESpace.Close)" : after > 512 ? "heap alto sem modulos retidos: lixo por recolher ou outra raiz" : "ok" };
    }

    /// <summary>Um comando -> um objeto (null = comando desconhecido). O mesmo Dispatch serve o processo frio (Main) e o worker (Serve).</summary>
    private static object? Dispatch(string command, string[] args)
    {
            object? data = command switch
            {
                "--version" => new { version = typeof(Program).Assembly.GetCustomAttributes(typeof(System.Reflection.AssemblyInformationalVersionAttribute), false).Cast<System.Reflection.AssemblyInformationalVersionAttribute>().FirstOrDefault()?.InformationalVersion },
                "ping" => new { pid = Environment.ProcessId, workingSetMB = Environment.WorkingSet >> 20, gcMB = GC.GetTotalMemory(false) >> 20, served = _served, loadedModules = RetainedModules(ModelHost.LoadedModules().Count), studio = StudioAssemblies.Directory },
                "gc" => Gc(),
                "statics" => Statics(args),
                "leak" => Leak(),
                "serve" => Serve(args),
                "inventory" => Inventory(args),
                "download" => Download(args),
                "publish-oml" => System.Text.Json.JsonSerializer.SerializeToNode(PublishOmlCommand.Run(args, Session), PublishOmlProtocol.Json),
                "data" => DataCommand.Run(args, Session),
                "users" => UsersCommand.Run(args, Session),
                "download-all" => DownloadAll(args),
                "download-app" => DownloadApp(args),
                "referenceable" => Referenceable(args),
                "templates" => Templates(args),
                "references" => References(args),
                "inspect" => Inspect(args),
                "debug-scope" => NativeDebugScope.Read(Host(args), Need(args, "--oml"), Need(args, "--expected-sha256"), Need(args, "--node-key"), Need(args, "--function-key"), Opt(args, "--previous-node-key")),
                "read-serve" => KernelSnapshotReading.Serve(Need(args, "--state"), Need(args, "--generation"), Opt(args, "--work") ?? ".local/reading"),
                "roundtrip" => RoundTrip(args),
                "merge-probe" => MergeProbeCmd(args),
                "publish-smoke" => PublishSmoke(args),
                "edit-smoke" => EditSmoke(args),
                "digest" => Digest(args),
                "rich-index" => RichIndex(args),
                "delete-app" => DeleteApp(args),
                "create-app" => CreateApp(args),
                "update-app" => UpdateApp(args),
                "create-module" => CreateModule(args),
                "add-modules" => AddModules(args),
                "set-user-provider" => SetUserProvider(args),
                "demo-vacation" => DemoVacation(args),
                "demo-temporada" => TemporadaRecipe.Run(Host(args), Need(args, "--base"), Need(args, "--out"), Log),
                "flow-nodes" => FlowNodes(args),
                "relayout" => Relayout(args),
                "catalog" => CatalogCmd(args),
                "ui-catalog" => UiCatalogCmd(args),
                "ui-block" => UiBlockCmd(args),
                "api" => ApiCmd(args),
                "ui-gallery" => UiGalleryCmd(args),
                "types" => TypesCmd(args),
                "check-delivery" => Anvil.Core.Delivery.DeliveryReceipt.Check(Need(args, "--result")),
                "check-job" => JobPreflight.Check(Need(args, "--job")),
                "apply" => ApplyCmd(args),
                "xif" => XifCommand.Run(args),
                "deliver" => DeliverCmd(args),
                "access" => AccessCmd(args),
                "app-session" => AppSessionCmd(args),
                "functions" => FunctionsCmd(args),
                "verify-message" => VerifyMessageCmd(args),
                "verify-catalog" => VerifyCatalogCmd(args),
                "where-can" => CommandSurface.WhereCan(RepoRoot(), Opt(args, "--catalog") ?? ModelCatalogPath(), Need(args, "--name")),
                "recipe" => CommandSurface.Recipes(RepoRoot(), Need(args, "--find"), args.Contains("--ops"),
                    Opt(args, "--max") is { } bound ? int.Parse(bound) : null),
                "prove" => ProofGenerator.Run(Host(args), Need(args, "--fixture"), Need(args, "--catalog"), Need(args, "--out"), Log, Opt(args, "--parent")),
                "scan" => CorpusScan.Run(Host(args), Need(args, "--dir"), Need(args, "--out"), Array.IndexOf(args, "--roundtrip") >= 0, Log, Opt(args, "--filter"), int.TryParse(Opt(args, "--max"), out var mx) ? mx : int.MaxValue),
                "refresh-refs" => RefreshRefs(args),
                "signature" => SignatureCmd(args),
                "dependencies" => DependenciesCmd(args),
                "signature-fixture" => SignatureFixtureCmd(args),
                _ => null,
            };
            return data;
    }

    /// <summary>Worker residente (item 5): `serve --port 4517`. Recebe por TCP loopback uma linha `{"args":["apply","--base",...]}`,
    /// executa o MESMO Dispatch em processo (assemblies do Studio ja carregados, JIT quente) e devolve o mesmo envelope JSON do
    /// CLI numa linha. Um pedido de cada vez, na ordem; `{"args":["shutdown"]}` encerra. Nenhum modelo passa de um pedido a
    /// outro: com a fila vazia, o worker carrega e percorre uma instancia NOVA da ultima base usada (BaseModelCache), que o
    /// proximo apply da mesma base (mesmos bytes, Studio, kernel e parametros de load) toma uma vez e liberta como sempre.
    /// O que poderia sobrar e estado estatico do runtime do Studio, e e isso que `scripts/worker_soak.py` (suite inteira N
    /// vezes contra o processo frio) tem de provar que nao muda o resultado.</summary>
    private static object Serve(string[] args)
    {
        var port = int.TryParse(Opt(args, "--port"), out var p) ? p : 4517;
        Anvil.Core.Delivery.BridgeAccess.Initialize();
        var workerCredential = Anvil.Core.Delivery.BridgeAccess.ReadCredential();
        var limit = int.TryParse(Environment.GetEnvironmentVariable("ANVIL_WORKER_MAX_COMMANDS"), out var n) && n > 0 ? n : 5000;
        var logDir = Path.GetFullPath(Opt(args, "--log-dir") ?? ".local"); Directory.CreateDirectory(logDir);
        var oldError = Console.Error;
        using var file = new StreamWriter(Path.Combine(logDir, $"worker-{port}-{Environment.ProcessId}.log"), append: true) { AutoFlush = true };
        Console.SetError(TextWriter.Synchronized(file));
        try
        {
            BaseModelCache.Enable(Log);
            // Read on the dispatch thread after each command and idle step; ping serves the last copy.
            JsonObject Metrics() => new() { ["loadedModules"] = RetainedModules(ModelHost.LoadedModules().Count), ["cachedModules"] = BaseModelCache.Held,
                ["baseCache"] = BaseModelCache.Stats() };
            using var server = new Anvil.Core.Hosting.WorkerServer(port, argv =>
            {
                var sw = Stopwatch.StartNew(); var command = argv[0];
                try
                {
                    if (command == "app-session") throw new InvalidOperationException("App host control is not a worker command");
                    var data = Dispatch(command, argv);
                    return data == null ? ErrorEnvelope(command, new ArgumentException("unknown command: " + command), sw.ElapsedMilliseconds)
                        : Envelope(command, data, sw.ElapsedMilliseconds);
                }
                catch (Exception ex) { Log(ex.ToString()); return ErrorEnvelope(command, ex, sw.ElapsedMilliseconds); }
                finally { Interlocked.Increment(ref _served); }
            }, limit, log: Log,
                commandMetrics: Metrics,
                initialMetrics: new JsonObject { ["studio"] = StudioAssemblies.Directory, ["loadedModules"] = 0, ["cachedModules"] = 0, ["authenticatedWorker"] = true,
                    ["baseCache"] = BaseModelCache.Stats() },
                authorize: request => Anvil.Core.Delivery.BridgeAccess.Matches(request["authorization"]?.ToString(), workerCredential),
                idle: BaseModelCache.Worker);
            Log($"anvil worker: listening on 127.0.0.1:{port} pid {Environment.ProcessId} studio {StudioAssemblies.Directory}");
            server.RunAsync().GetAwaiter().GetResult();
            return new { stopped = true, commands = _served };
        }
        finally { Console.SetError(oldError); }
    }

    // ---- server commands ------------------------------------------------

    /// <summary>Without --credentials the session runs through the Studio already logged in on the lane (SSO included):
    /// each server call is executed by the bridge with the Studio's own session, so no secret leaves the Studio.
    /// --credentials keeps the legacy username/password file for environments that still accept it.</summary>
    private static HeadlessSession Session(string[] args)
    {
        var path = Opt(args, "--credentials");
        if (path == null)
        {
            var port = int.TryParse(Opt(args, "--bridge-port") ?? Environment.GetEnvironmentVariable("ANVIL_BRIDGE_PORT"), out var parsed) ? parsed
                : Environment.GetEnvironmentVariable("ANVIL_LANE") == "ss5" ? 4536 : 4516;
            var connected = HeadlessSession.ConnectStudio(new BridgeClient(port, 330),
                Opt(args, "--host"), Opt(args, "--module"), args.Contains("--read-only"));
            Log($"connected through the Studio on bridge {port} to {connected.Host}; no credential file");
            return connected;
        }
        var creds = HeadlessCredentials.FromJsonFile(path, Opt(args, "--host"));
        if (Array.IndexOf(args, "--read-only") >= 0) creds = new HeadlessCredentials { Host = creds.Host, Username = creds.Username, Password = creds.Password, ReadOnly = true };
        var s = HeadlessSession.Connect(creds);
        Log($"connected to {s.Host} as {s.Username}: server {s.ServerVersion}, ide {s.IdeVersion}, {s.ConnectMs} ms");
        return s;
    }

    private static object Inventory(string[] args)
    {
        using var s = Session(args);
        var apps = s.ListApplications();
        var mods = s.ListModules();
        var cats = s.ListCatalogs();
        Log($"{apps.Count} applications, {mods.Count} modules, {cats.Count} catalogs");
        var data = new
        {
            host = s.Host, serverVersion = s.ServerVersion?.ToString(), ideVersion = s.IdeVersion,
            capturedAtUtc = DateTime.UtcNow, applications = apps, modules = mods, catalogs = cats,
        };
        var outDir = Opt(args, "--out");
        if (outDir != null)
        {
            Directory.CreateDirectory(outDir);
            File.WriteAllText(Path.Combine(outDir, "inventory.json"), Json.Serialize(data));
        }
        return data;
    }

    private static object Download(string[] args)
    {
        using var s = Session(args);
        var version = Opt(args, "--version") is { } v ? int.Parse(v) : (int?)null;
        // K1-c: --cache <lane.local>/environment/published downloads each module version once (PublishedOmlCache).
        if (Opt(args, "--cache") is { } cache)
        {
            var module = s.FindModule(Need(args, "--module")) ?? throw new KeyNotFoundException($"module not found in {s.Host}: {Need(args, "--module")}");
            var cached = PublishedOmlCache.Download(cache, module, version, Need(args, "--out"), (m, o, vid) => s.Download(m, o, vid),
                key => s.ListVersionIds(key).FirstOrDefault(), Log);
            Log($"{cached.Name} {cached.Status} {cached.Bytes} bytes {cached.ElapsedMs} ms cached={cached.Cached}");
            return cached;
        }
        var r = s.Download(Need(args, "--module"), Need(args, "--out"), version);
        Log($"{r.Name} {r.Status} {r.Bytes} bytes {r.ElapsedMs} ms");
        return r;
    }

    private static object DownloadAll(string[] args)
    {
        using var s = Session(args);
        var filter = Opt(args, "--filter");
        var results = s.DownloadAll(Need(args, "--out"),
            filter == null ? null : m => m.Name.Contains(filter, StringComparison.OrdinalIgnoreCase),
            r => Log($"  {r.Name,-40} {r.Status,-8} {r.Bytes,9} bytes {r.ElapsedMs,6} ms"));
        return Summ(results);
    }

    private static object DownloadApp(string[] args)
    {
        using var s = Session(args);
        var apps = Need(args, "--app").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var results = s.DownloadApplications(Need(args, "--out"), apps,
            r => Log($"  {r.Name,-40} {r.Status,-8} {r.Bytes,9} bytes {r.ElapsedMs,6} ms"));
        return Summ(results);
    }

    private static object Referenceable(string[] args)
    {
        using var s = Session(args);
        var refs = s.ListReferenceable();
        Log($"{refs.Count} referenceable producers");
        return refs;
    }

    private static object Templates(string[] args)
    {
        using var s = Session(args);
        var list = s.ListApplicationTemplates();
        Log($"{list.Count} application templates");
        // --with-host: {host, templates}, so o11_environment caches the list per environment (create-app --templates).
        return args.Contains("--with-host") ? new { host = s.Host, templates = list } : list;
    }

    /// <summary>create-app --templates &lt;file&gt;: the o11_environment templates cache ({host, templates:[TemplateSummary]}),
    /// used by FindTemplateForKind only when its host is this session's (HeadlessSession.UseKnownTemplates); an unreadable
    /// file is ignored (the live read runs as before).</summary>
    private static void KnownTemplates(HeadlessSession s, string? file)
    {
        if (string.IsNullOrEmpty(file) || !File.Exists(file)) return;
        try
        {
            var node = JsonNode.Parse(File.ReadAllText(file))!.AsObject();
            var options = new System.Text.Json.JsonSerializerOptions { PropertyNameCaseInsensitive = true };
            var templates = node["templates"] is { } list ? System.Text.Json.JsonSerializer.Deserialize<List<TemplateSummary>>(list, options) : null;
            Log(s.UseKnownTemplates(node["host"]?.ToString(), templates) ? $"templates of {s.Host} from {file}" : $"templates file {file} is not of {s.Host}; reading the server");
        }
        catch (Exception ex) when (ex is IOException or System.Text.Json.JsonException or InvalidOperationException or UnauthorizedAccessException)
        { Log("templates file ignored: " + ex.Message); }
    }

    private static object Summ(IReadOnlyList<DownloadResult> results) => new
    {
        total = results.Count,
        ok = results.Count(r => r.Status == "ok"),
        bytes = results.Where(r => r.Status == "ok").Sum(r => r.Bytes),
        elapsedMs = results.Sum(r => r.ElapsedMs),
        results,
    };

    // ---- model commands -------------------------------------------------

    private static ModelHost Host(string[] args) => new(Opt(args, "--work") ?? Path.Combine(Path.GetTempPath(), "sshedless-work"));

    private static object References(string[] args) => Host(args).References(File.ReadAllBytes(Need(args, "--oml")));

    /// <summary>A reading the module index answers exactly (Anvil.Reading.ModuleIndex.Answerable), from the stored index of
    /// these bytes and before any Studio assembly is bound. Null means the model answers, as before, and stores the index.</summary>
    private static JsonObject? IndexedInspect(string[] args)
    {
        try
        {
            if (!Anvil.Reading.ReadingOptions.Requested(args) || Opt(args, "--oml") is not { } oml) return null;
            var data = Anvil.Reading.ModuleIndex.ReadStored(Anvil.Reading.ModuleIndexStore.Default(), oml, Opt(args, "--path") ?? "/", Anvil.Reading.ReadingOptions.Parse(args));
            if (data != null) Log("module index: answered from the stored index of " + data["sourceSha256"]);
            return data;
        }
        catch { return null; } // the model path reports the same input errors
    }

    /// <summary>`digest --oml &lt;capture&gt; [--out &lt;file.txt&gt;]`: the module digest (ssam-digest) of the capture, from the
    /// store beside its module index, else built from the model and stored. Answers its file and sizes; --out writes the
    /// text. The facade pages it (ssam map --digest).</summary>
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

    /// <summary>`rich-index --oml &lt;capture&gt;`: the rich module index (ssam-rich-index) of the capture, from the store beside
    /// its module index, else built from the model and stored. Answers its file and counts; the facade searches it and reads
    /// usages from it (ssam map --view search|uses).</summary>
    private static object RichIndex(string[] args)
    {
        var store = Anvil.Reading.ModuleIndexStore.Default()
            ?? throw new InvalidOperationException("No module index store: set SSAM_MODULE_INDEX_ROOT or run inside an SSAM workspace");
        var answer = Anvil.Reading.ModuleRichIndex.Ensure(store, Need(args, "--oml"), (bytes, sha) => Host(args).BuildRich(bytes, sha, store.Lane));
        Log("rich-index: " + answer["bytes"] + " bytes, " + answer["counts"]!["elements"] + " elements, " + (answer["built"]!.GetValue<bool>() ? "built" : "stored") + " " + answer["path"]);
        return answer;
    }
    private static object Inspect(string[] args)
    {
        if (Anvil.Reading.ReadingOptions.Requested(args))
            return Host(args).ReadModel(Need(args, "--oml"), Opt(args, "--path") ?? "/", Anvil.Reading.ReadingOptions.Parse(args),
                Anvil.Reading.ModuleIndexStore.Default());
        var snap = Host(args).Inspect(Need(args, "--oml"));
        Log($"{snap.Name} ({snap.Kind}): {snap.Objects} objects, {snap.References.Count} references, {snap.Validation.Total} messages, load {snap.LoadMs} ms");
        return snap;
    }

    /// <summary>Merge de 3 vias headless (o MatchTree do Studio): base = --base, foreign = --foreign; --out grava o resultado.
    /// Prova de fidelidade de um delta antes do merge no Studio: objetos iguais aos do foreign, Verify valido, sem conflitos.</summary>
    private static object MergeProbeCmd(string[] args)
    {
        var r = MergeProbe.ThreeWay(Host(args), File.ReadAllBytes(Need(args, "--base")), File.ReadAllBytes(Need(args, "--foreign")), Opt(args, "--out"));
        Log($"merge-probe: local {r.LocalObjects} objects, foreign {r.ForeignObjects}, valid={r.LocalIsValid}, errors={r.Errors}, warnings={r.Warnings}, conflicts={r.HasConflicts}");
        return r;
    }

    private static object RoundTrip(string[] args)
    {
        var oml = Need(args, "--oml");
        var saved = Path.Combine(Need(args, "--out"), Path.GetFileNameWithoutExtension(oml) + ".roundtrip.oml");
        var r = Host(args).RoundTrip(File.ReadAllBytes(oml), saved);
        Log($"{r.Original.Name}: load {r.Original.LoadMs} ms, save {r.SaveMs} ms, reload {r.Reloaded.LoadMs} ms; sameKey={r.SameKey} sameObjects={r.SameObjectCount} sameValidation={r.SameValidation}");
        return r;
    }

    // ---- fase 3: app + modulo + action + publish ------------------------

    private static object PublishSmoke(string[] args)
    {
        using var s = Session(args);
        return Publisher.SmokePublish(s, Host(args),
            Opt(args, "--app") ?? "ZZHeadless", Opt(args, "--module") ?? "ZZHeadless_CS", Opt(args, "--action") ?? "Ping",
            Need(args, "--out"), Log);
    }

    /// <summary>Baixa um modulo existente, adiciona uma Server Action e republica (sem GUI).</summary>
    private static object EditSmoke(string[] args)
    {
        using var s = Session(args);
        return Publisher.AddServerActionAndRepublish(s, Host(args), Opt(args, "--module") ?? "ZZHeadless_CS",
            Opt(args, "--action") ?? "Pong", Need(args, "--out"), Log);
    }

    /// <summary>Apaga uma app de teste. Sem --confirm so simula (o servidor relata o impacto).</summary>
    private static object DeleteApp(string[] args)
    {
        using var s = Session(args);
        var app = s.FindApplication(Need(args, "--app")) ?? throw new KeyNotFoundException("application not found");
        if (!app.Name.StartsWith("ZZ", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("refusing to delete an application whose name does not start with ZZ (test convention)");
        var simulate = Array.IndexOf(args, "--confirm") < 0;
        var r = Publisher.DeleteApplication(s, app.Key, simulate);
        Log($"delete {app.Name} simulate={simulate}: ok={r.Ok} affected={string.Join(",", r.AffectedApplications)} deleted={string.Join(",", r.DeletedModules)}");
        return new { application = app, r.Ok, r.Simulated, r.Messages, r.AffectedApplications, r.DeletedModules };
    }

    /// <summary>Staleness das referencias de um modulo contra o catalogo e refresh sem GUI (publica so com --publish).</summary>
    private static object RefreshRefs(string[] args)
    {
        using var s = Session(args);
        return ReferenceRefresher.RefreshModule(s, Host(args), Need(args, "--module"), Need(args, "--out"),
            onlyStale: Array.IndexOf(args, "--all") < 0, publish: Array.IndexOf(args, "--publish") >= 0, Log);
    }

    /// <summary>Manage Dependencies sem GUI, so leitura: captura a assinatura atual de um produtor do ambiente (extensao,
    /// eSpace ou (System)) pelo Studio logado, com lease readOnly, guarda de VersionId antes/depois e resolucao
    /// Tipo:Nome -> OriginalKey na propria assinatura. Grava um .avsig atestado (FormatVersion 2); --pin-xif baixa o .xif
    /// da versao capturada para a mesma pasta e devolve o SHA-256. Nunca aceita --credentials nem escreve no ambiente.
    /// signature --producer PdfText [--key k] [--kind Extension|eSpace] [--elements "IServerActionSignature:X,..." | --job j.json [--binding B]]
    ///           [--pin-xif] --out <abs>\PdfText.avsig [--host h] [--bridge-port 4516]</summary>
    private static object SignatureCmd(string[] args)
    {
        if (args.Contains("--credentials"))
            throw new SignatureCaptureException("NotReadOnly", "signature uses only the Studio's own read-only lease; --credentials is refused");
        var port = int.TryParse(Opt(args, "--bridge-port") ?? Environment.GetEnvironmentVariable("ANVIL_BRIDGE_PORT"), out var parsed) ? parsed
            : Environment.GetEnvironmentVariable("ANVIL_LANE") == "ss5" ? 4536 : 4516;
        using var session = HeadlessSession.ConnectStudio(new BridgeClient(port, 330), Opt(args, "--host"), null, readOnly: true);
        Log($"signature: read-only lease on bridge {port} to {session.Host}; no credential file");
        // --job <job.json> [--binding <Name>]: the elements are those the job's reference ops ask of that binding.
        var elements = Opt(args, "--job") is { } job
            ? Anvil.Core.Delivery.ProducerSignatures.ReferencedElements(job, Opt(args, "--binding") ?? Need(args, "--producer")).ToArray()
            : (Opt(args, "--elements") ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return ProducerSignatureCapture.Capture(session, new SignatureCaptureRequest(Need(args, "--producer"), elements,
            args.Contains("--list") ? "" : Need(args, "--out"),
            Opt(args, "--key"), Opt(args, "--kind"), args.Contains("--pin-xif"), args.Contains("--list"),
            int.Parse(Opt(args,"--offset")??"0"),int.Parse(Opt(args,"--limit")??"100"),Opt(args,"--expected-signature-hash")), Log);
    }

    private static object DependenciesCmd(string[] args) => (args.Length>1?args[1]:"help") switch {
        "producers" => Referenceable(args),
        "list" => SignatureCmd(args.Concat(new[]{"--list"}).ToArray()),
        "capture" => SignatureCmd(args),
        "inspect" => References(args),
        "deliver" => Dispatch("deliver",args)!,
        "help" => new { actions=new[]{"producers","list","capture","inspect","deliver"},
            families=NativeReferenceKinds.All, examples=new[]{
                "ssam dependencies list --lane o11 --producer OutSystemsUI",
                "ssam dependencies capture --lane o11 --producer Library --elements IRole:Operator,IBlockSignature:Widgets/Card --out Library.avsig",
                "ssam dependencies deliver --lane o11 --module Consumer --job dependencies.json --capture-producer Library"},
            model="Only public referenceable elements; jobs change a headless candidate and delivery uses native merge. No publication." },
        _ => throw new ArgumentException("dependencies: use producers|list|capture|inspect|deliver|help")
    };

    /// <summary>EVIDENCIA OFFLINE, nunca entregavel: monta um .avsig atestado sem servidor, para provar os caminhos de
    /// eSpace e (System) em copias locais. --from-oml <produtor.oml> usa a assinatura que o OML do produtor carrega;
    /// --from-consumers a.oml,b.oml --key <chave> [--system] regenera os elementos da referencia existente nesses
    /// consumidores e confere cada um contra o hash que o consumidor guardou do servidor. O deliver recusa as duas fontes.</summary>
    private static object SignatureFixtureCmd(string[] args)
    {
        var elements = (Opt(args, "--elements") ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var environment = Opt(args, "--environment") ?? SignatureFixtures.OfflineEnvironment;
        var fixture = Opt(args, "--from-oml") is { } oml ? SignatureFixtures.FromProducerOml(oml, elements, environment)
            : SignatureFixtures.FromConsumers(Host(args), Need(args, "--from-consumers").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries),
                Need(args, "--key"), elements, args.Contains("--system"), environment);
        var outPath = Path.GetFullPath(Need(args, "--out"));
        Directory.CreateDirectory(Path.GetDirectoryName(outPath)!);
        fixture.Snapshot.Write(outPath);
        fixture.Report["avsigPath"] = outPath; fixture.Report["avsigSha256"] = Anvil.Core.Delivery.DeliveryReceipt.Hash(outPath);
        return fixture.Report;
    }

    /// <summary>App + modulos em branco: --name Headless --kind Reactive --modules Headless_UI:Reactive,Headless_CS:Service</summary>
    private static object CreateApp(string[] args)
    {
        var specs = Need(args, "--modules").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(x => { var p = x.Split(':'); return new ModuleSpec(p[0], p.Length > 1 ? p[1] : "Service"); }).ToList();
        var blank = Array.IndexOf(args, "--blank") >= 0;
        // A16: refused before the Studio lease, so nothing reaches the environment.
        AppFactory.RefuseBlankUi(specs, blank);
        using var s = Session(args);
        KnownTemplates(s, Opt(args, "--templates"));
        // Host: the environment of the answer, so o11_environment adds the created modules to its cached inventory.
        return AppFactory.CreateApplicationWithModules(s, Host(args), Need(args, "--name"), Opt(args, "--kind") ?? "Reactive", specs,
            Need(args, "--out"), Opt(args, "--template-key"), Log, Opt(args, "--color"), null, blankModules: blank,
            preferTemplateLabel: Opt(args, "--template")) with { Host = s.Host };
    }

    /// <summary>Atualiza cor/descricao de uma app existente: --name Headless --color #2E86C1</summary>
    private static object UpdateApp(string[] args)
    {
        using var s = Session(args);
        var (key, ok, msg) = AppFactory.UpdateApplication(s, Need(args, "--name"), Opt(args, "--color"), null, Opt(args, "--description"));
        var after = s.ListApplications(refresh: true).FirstOrDefault(a => a.Key == key);
        return new { key, ok, message = msg, after };
    }

    /// <summary>Modulo a partir do template da app: --app Headless --name Headless_UI [--replace] [--template-key k] [--no-publish]</summary>
    private static object CreateModule(string[] args)
    {
        using var s = Session(args);
        var name = Need(args, "--name");
        string? existingKey = null;
        if (Array.IndexOf(args, "--replace") >= 0)
            existingKey = s.FindModule(name)?.Key ?? throw new KeyNotFoundException("--replace given but module not found: " + name);
        return TemplateModules.CreateModuleFromTemplate(s, Host(args), Need(args, "--app"), name, Need(args, "--out"),
            Opt(args, "--template-key"), existingKey, Opt(args, "--description"), publish: Array.IndexOf(args, "--no-publish") < 0, Log);
    }

    /// <summary>Adiciona modulos a uma app existente: --app Headless --modules Headless_Lib:Library [--blank]</summary>
    private static object AddModules(string[] args)
    {
        var specs = Need(args, "--modules").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(y => { var p = y.Split(':'); return new ModuleSpec(p[0], p.Length > 1 ? p[1] : "Service"); }).ToList();
        var blank = Array.IndexOf(args, "--blank") >= 0;
        AppFactory.RefuseBlankUi(specs, blank);
        using var s = Session(args);
        var app = s.FindApplication(Need(args, "--app")) ?? throw new KeyNotFoundException("application not found");
        var results = AppFactory.AddModulesToApplication(s, Host(args), app.Key, Opt(args, "--template-key") ?? app.TemplateKey, specs, Need(args, "--out"),
            blankModules: blank, Log);
        return new { application = app, modules = results, succeeded = results.All(m => m.Succeeded), host = s.Host };
    }

    /// <summary>Troca o user provider de um modulo publicado: --module Headless_Lib [--provider-name Users] [--provider-key K] --out DIR</summary>
    private static object SetUserProvider(string[] args)
    {
        using var s = Session(args);
        return Publisher.SetUserProviderAndRepublish(s, Host(args), Need(args, "--module"), Need(args, "--out"),
            Opt(args, "--provider-name"), Opt(args, "--provider-key"), Log);
    }

    /// <summary>Carga de prova do merge: --base <oml do modulo aberto> --out <oml resultante></summary>
    private static object DemoVacation(string[] args)
        => VacationRentalRecipe.Run(Host(args), Need(args, "--base"), Need(args, "--out"), Log);

    /// <summary>Nos e posicoes de uma action num OML: --oml <path> --action <Nome></summary>
    private static object FlowNodes(string[] args)
    {
        return Host(args).FlowNodesFromOml(File.ReadAllBytes(Need(args, "--oml")), Need(args, "--action"));
    }

    /// <summary>Auto-layout dos fluxos: --base <oml> --out <oml> [--actions A,B]</summary>
    private static object Relayout(string[] args)
        => Host(args).RelayoutFromOml(File.ReadAllBytes(Need(args, "--base")), Need(args, "--out"), Opt(args, "--actions")?.Split(',', StringSplitOptions.RemoveEmptyEntries), Log);

    /// <summary>Catalogo do Model API por reflexao sobre a DLL instalada: --out <json> [--studio-dir <dir>]</summary>
    /// ui-catalog --oml <lib.oml> [--oml <other.oml>...] --out <dir json> [--assets <dir local>] [--docs <dir markdown>]
    private static object UiCatalogCmd(string[] args)
    {
        var host = Host(args);
        var outDir = Need(args, "--out");
        var assets = Opt(args, "--assets");
        var docs = Opt(args, "--docs");
        var omls = args.Select((a, i) => a == "--oml" && i + 1 < args.Length ? args[i + 1] : null).Where(x => x != null).Select(x => x!).ToList();
        if (omls.Count == 0) throw new ArgumentException("missing --oml");
        var summaries = new List<object>();
        foreach (var oml in omls)
        {
            var m = UiCatalog.Build(host, oml, assets, Log);
            var json = Path.Combine(outDir, $"{m.Name}-{m.Version ?? "unversioned"}.json");
            UiCatalog.WriteJson(m, json);
            if (docs != null) UiCatalogDocs.Write(m, Path.Combine(docs, m.Name));
            Log($"  -> {json}" + (docs != null ? $" + docs em {Path.Combine(docs, m.Name)}" : ""));
            summaries.Add(new { file = json, summary = UiCatalog.Summary(m) });
        }
        return summaries;
    }

    /// ui-gallery --fixture <oml> --catalog <json> [--catalog <json>...] --out <dir> --runtime Reactive|Mobile|Traditional [--flow <UI flow>] [--block <nome>]
    private static object UiGalleryCmd(string[] args)
    {
        var catalogs = args.Select((a, i) => a == "--catalog" && i + 1 < args.Length ? args[i + 1] : null).Where(x => x != null).Select(x => x!).ToList();
        if (catalogs.Count == 0) throw new ArgumentException("missing --catalog");
        var producers = ProducerBindings(args);
        return UiGallery.Run(Host(args), Need(args, "--fixture"), catalogs, Need(args, "--out"), Opt(args, "--runtime") ?? "Reactive", Log, Opt(args, "--flow"), Opt(args, "--block"), producers.Count == 0 ? null : producers);
    }

    /// api --name <Interface curta ou completa> [--catalog <json>]: propriedades (gravaveis com *), enums, quem cria e o que cria
    private static object ApiCmd(string[] args)
    {
        if (Opt(args, "--op") is { } op)
        {
            // `native` reflecte os assemblies do Studio carregados: precisa da instalacao ligada (Main salta o Bind para `api`).
            if (op == "native") { StudioAssemblies.Bind(Opt(args, "--ss-dir") ?? Opt(args, "--studio-dir")); return NativeSurface.Describe(Need(args, "--type")); }
            return CommandSurface.Schema(op);
        }
        var path = Opt(args, "--catalog") ?? Directory.GetFiles(Path.Combine(RepoRoot(), "catalog"), "model-api-*.json").OrderByDescending(f => f).First();
        var doc = JsonNode.Parse(File.ReadAllText(path))!.AsObject();
        var name = Need(args, "--name");
        if (ApiCatalog.Enum(name, doc) is { } enumeration)
            return new { name = enumeration["Namespace"] + "." + enumeration["Name"], values = enumeration["Values"]!.DeepClone() };
        var hits = doc["Interfaces"]!.AsArray().Where(i => string.Equals(i!["Name"]!.GetValue<string>(), name, StringComparison.OrdinalIgnoreCase)
            || string.Equals(i!["Name"]!.GetValue<string>().Split('.').Last(), name, StringComparison.OrdinalIgnoreCase)).ToList();
        if (hits.Count == 0) return new { notFound = name, hint = "use o nome curto (IForEachNode) ou completo; veja tambem 'find' num job" };
        var creatables = doc["Creatables"]!.AsArray();
        return hits.Select(i =>
        {
            var full = i!["Name"]!.GetValue<string>();
            return new
            {
                name = full,
                bases = i["Bases"]?.AsArray().Select(b => b!.GetValue<string>().Split('.').Last()).ToList(),
                properties = i["Properties"]!.AsArray().Select(p => (p!["CanWrite"]!.GetValue<bool>() ? "*" : "") + p["Name"]!.GetValue<string>() + ": " + p["Type"]!.GetValue<string>().Split('.').Last()).ToList(),
                enumValues = ApiCatalog.Properties(full).Select(p => p["Type"]!.ToString()).Distinct()
                    .Where(t => ApiCatalog.Enum(t, doc) != null).ToDictionary(t => t.Split('.').Last(), t => ApiCatalog.Enum(t, doc)!["Values"]!.DeepClone()),
                createdBy = creatables.Where(c => c!["Type"]!.GetValue<string>() == full).Select(c => c!["Parent"]!.GetValue<string>().Split('.').Last() + "." + c["Via"]!.GetValue<string>()).Distinct().ToList(),
                creates = creatables.Where(c => c!["Parent"]!.GetValue<string>() == full).Select(c => c!["Type"]!.GetValue<string>().Split('.').Last()).Distinct().ToList(),
            };
        }).ToList();
    }

    private static string ModelCatalogPath() => Directory.GetFiles(Path.Combine(RepoRoot(), "catalog"), "model-api-*.json").OrderByDescending(f => f).First();

    /// <summary>`verify-message --name X | --find texto` explica uma mensagem; `--out catalog/verify-messages-&lt;ver&gt;.json`
    /// grava a LISTA DE IDS do Studio instalado, que e o manifesto contra o qual os jobs declaram expectedMessages.
    /// So o id: o texto da mensagem e do fabricante e nunca entra no repo.</summary>
    private static object VerifyMessageCmd(string[] args)
    {
        StudioAssemblies.Bind(Opt(args, "--studio-dir"));
        if (Opt(args, "--out") is { } outPath)
        {
            var ids = VerifyCatalog.All.Select(m => m.Id).Order(StringComparer.Ordinal).ToList();
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outPath))!);
            File.WriteAllText(outPath, System.Text.Json.JsonSerializer.Serialize(ids.Select(id => new { id }),
                new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
            return new { wrote = outPath, studio = FunctionCatalog.StudioVersion, count = ids.Count };
        }
        var name = Opt(args, "--name");
        if (name != null && Opt(args, "--find") != null) throw new ArgumentException("use --name OR --find");
        return CommandSurface.VerifyMessages(VerifyCatalog.All, VerifyHints.Read(RepoRoot()), name ?? Need(args, "--find"), name != null);
    }

    private static string RepoRoot()
    {
        var dir = AppContext.BaseDirectory;
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }

    /// ui-block --catalog <json> --name <Block> | --find <texto>
    private static object UiBlockCmd(string[] args)
    {
        var m = UiCatalog.ReadJson(Need(args, "--catalog"));
        var name = Opt(args, "--name");
        if (name != null)
            return m.Blocks.FirstOrDefault(b => string.Equals(b.Name, name, StringComparison.OrdinalIgnoreCase))
                   ?? throw new ArgumentException($"block '{name}' not in {m.Name} {m.Version}; try --find");
        var find = Need(args, "--find");
        return m.Blocks.Where(b => b.Name.Contains(find, StringComparison.OrdinalIgnoreCase) || (b.Description ?? "").Contains(find, StringComparison.OrdinalIgnoreCase))
            .Select(b => new { b.Name, b.Flow, b.Public, b.Description, Inputs = b.Inputs.Select(i => i.Name), Placeholders = b.Placeholders.Select(x => x.Name), Events = b.Events.Select(e => e.Name) }).ToList();
    }

    private static object CatalogCmd(string[] args)
    {
        StudioAssemblies.Bind(Opt(args, "--studio-dir"));
        var dir = StudioAssemblies.Directory!;
        var c = Catalog.Extract(dir);
        var outPath = Need(args, "--out");
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outPath))!);
        File.WriteAllText(outPath, Catalog.ToJson(c));
        Log($"catalog: {c.Assembly} {c.AssemblyVersion}: {string.Join(", ", c.Summary.Select(k => k.Key + "=" + k.Value))}");
        return new { outPath, c.Assembly, c.AssemblyVersion, c.Summary };
    }

    /// <summary>A identidade da instalacao ligada e o catalogo de mensagens do Verify (o mesmo contrato que `anvil-odc
    /// verify-catalog`): plataforma, versao do IDE, pasta, definicoes. E o que a descoberta le para classificar um
    /// resultado carimbado como atual ou historico nesta faixa.</summary>
    private static object VerifyCatalogCmd(string[] args)
    {
        var all = StudioAdapter.Runtime.VerifyDefinitions;
        if (Opt(args, "--id") is not { } id)
            return new { platform = StudioAdapter.Runtime.Platform, ideVersion = StudioAdapter.Runtime.IdeVersion, studioDirectory = StudioAdapter.Runtime.StudioDirectory, count = all.Count, definitions = all };
        var found = all.FirstOrDefault(d => string.Equals(d.Id, id, StringComparison.OrdinalIgnoreCase));
        return found is null ? new { notFound = id, count = all.Count } : (object)found;
    }

    /// <summary>Aplica um job de verbos a um OML: --base <oml> --job <json> --out <oml>. Escreve <out>.result.json com o
    /// resultado e o carimbo de proveniencia (a mesma forma que a suite grava), como a faixa ODC ja fazia.</summary>
    private static object ApplyCmd(string[] args)
    {
        JobRunner.CheckJobName(Need(args, "--job"));   // regra de nome ANTES de subir o runtime (plano, item 09)
        JobRunner.ValidateJob(Need(args, "--job"));
        // the job a patched or partial job corrects (job-patch.mjs): the CSS loss guard of the preflight compares the two
        JobPreflight.BasedOn.Value = Opt(args, "--based-on") is { Length: > 0 } basedOn ? Path.GetFullPath(basedOn) : null;
        // Every problem at once, with the code and the structured problems in the error envelope (PREFLIGHT_REFUSED, I2).
        // primeira-certa A2: the preflight runs inside JobRunner, which goes on to the base check, the apply and the Verify
        // when the base loads, and refuses once with every phase (verifyRan says whether the Verify ran).
        var producers = ProducerBindings(args);
        var jobPath = Need(args, "--job"); var outPath = Need(args, "--out");
        var host = Host(args);
        object result;
        // K1: the bound producer signatures are linked to this execution (owners of foreign types join the same refresh).
        using (Anvil.Core.Delivery.Delivery.LinkSignatures(producers)) result = JobRunner.Run(host, Opt(args, "--base"), jobPath, outPath, Log, producers);
        try
        {
            var node = System.Text.Json.JsonSerializer.SerializeToNode(result)!.AsObject();
            node["provenance"] = JobProvenance.Stamp("Anvil.Cli", jobPath, null);
            // The job and every file it read: a delivery reuses this candidate only while they hash the same (PrebuiltCandidate).
            node["sources"] = Anvil.Core.Delivery.DeliveryReceipt.Sources(jobPath);
            File.WriteAllText(Path.ChangeExtension(outPath, ".result.json"), node.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
        }
        catch (Exception ex) { Log("result.json not written: " + ex.Message); }
        return result;
    }

    private static object DeliverCmd(string[] args)
    {
        if (args.Contains("--base") || args.Contains("--publish")) throw new ArgumentException("deliver takes its own registered snapshot and never publishes; --base/--publish are not accepted");
        var port = int.TryParse(Opt(args, "--port"), out var p) ? p
            : Environment.GetEnvironmentVariable("ANVIL_LANE") == "ss5" ? 4536 : 4516;
        var work = Path.GetFullPath(Opt(args, "--work") ?? (Environment.GetEnvironmentVariable("ANVIL_LANE") == "ss5" ? ".local/lane-ss5/work" : ".local/work"));
        if (Opt(args, "--close") is { } closedId)
        {
            if (args.Any(a => a is "--job" or "--spec" or "--module" or "--resume" or "--producer" or "--capture-producer")) throw new ArgumentException("Close uses the original task and cannot replace its request");
            var original = Anvil.Core.Delivery.DeliveryTask.ResumeRequest(work, closedId);
            if(original.BridgePort != null && original.BridgePort != port) throw new ArgumentException("Close must use the task's original Studio lane");
            Anvil.Core.Delivery.DeliverArguments.RequireRecordedEnvironment(args, original);
            return Anvil.Core.Delivery.DeliveryTask.CloseKnownFailure(work, closedId, Need(args, "--reason"), new BridgeClient(port));
        }
        Anvil.Core.Delivery.DeliveryRequest request;
        if (Opt(args, "--resume") is { } id)
        {
            if (args.Any(a => a is "--job" or "--spec" or "--module" or "--checks" or "--producer" or "--capture-producer"))
                throw new ArgumentException("Resume uses the original task; job, target, checks and producers cannot be replaced");
            request = Anvil.Core.Delivery.DeliveryTask.ResumeRequest(work, id);
            if (request.BridgePort != null && request.BridgePort != port) throw new ArgumentException("Resume must use the task's original Studio lane");
            Anvil.Core.Delivery.DeliverArguments.RequireRecordedEnvironment(args, request);
            // K1-g: closing the tab is a property of this call, never of the task identity.
            request = request with { CloseOpenedTab = Anvil.Core.Delivery.DeliverArguments.CloseOpenedTab(args) };
        }
        else if (Opt(args, "--spec") is { } specificationPath)
        {
            if (args.Any(a => a is "--job" or "--checks" or "--producer" or "--capture-producer"))
                throw new ArgumentException("Data specification determines its checks and implementation; job/checks/producer overrides are not accepted");
            specificationPath = Path.GetFullPath(specificationPath);
            var specification = ModuleSpecification.Read(specificationPath);
            request = new(Need(args, "--module"), specificationPath, work, Array.Empty<string>(), BridgePort: port,
                Specification: specification, ExpectedEnvironment: Anvil.Core.Delivery.DeliverArguments.ExpectedEnvironment(args));
        }
        // --expected-environment: the environment attestation; --capture-producer: read-only producer captures
        else request = Anvil.Core.Delivery.DeliverArguments.ForJob(args, work, port);
        // --prebuilt: the candidate the build phase made outside the Studio lock (lane wp); reused only on the same model.
        var prebuilt = request.Specification == null && Opt(args, "--resume") == null ? Opt(args, "--prebuilt") : null;
        // The build phase captured the module's tab by key in this call: the open skips the references check (OpeningOwnTab).
        if (prebuilt != null && File.Exists(prebuilt)) request = request with { SkipOpenReferencesCheck = true };
        return RunDelivery(request, port, prebuilt);
    }

    /// <summary>The one delivery path: `deliver` and `access apply --execute` both end here.</summary>
    private static JsonObject RunDelivery(Anvil.Core.Delivery.DeliveryRequest request, int port, string? prebuilt = null)
    {
        JsonObject ApplyJob(string basePath, string jobPath, string output, IReadOnlyDictionary<string, string>? producers)
            => Anvil.Core.Delivery.PrebuiltCandidate.Apply(prebuilt, basePath, jobPath, output, producers, typeof(ModelSession).Assembly.Location,
                () => ApplyFresh(basePath, jobPath, output, producers), Log);
        JsonObject ApplyFresh(string basePath, string jobPath, string output, IReadOnlyDictionary<string, string>? producers)
        {
            var host = new ModelHost(Path.Combine(Path.GetDirectoryName(output)!, "model"));
            if (request.Specification != null)
            {
                var candidate = new JsonObject { ["ops"] = host.PlanModuleSpecification(basePath, request.Specification),
                    ["expectedMessages"] = ModuleSpecification.SourceDocument(request.JobPath)["expectedMessages"]?.DeepClone() ?? new JsonArray() };
                jobPath = Path.Combine(Path.GetDirectoryName(output)!, "generated.json");
                Anvil.Core.Delivery.DurableJson.WriteBytes(jobPath, System.Text.Encoding.UTF8.GetBytes(candidate.ToJsonString()));
            }
            return System.Text.Json.JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, jobPath, output, Log, producers))!.AsObject();
        }
        return Anvil.Core.Delivery.Delivery.Run(new BridgeClient(port), request, (basePath, jobPath, output) => ApplyJob(basePath, jobPath, output, request.Producers), Log,
            (snapshot, assertions) => new ModelHost(Path.Combine(Path.GetDirectoryName(snapshot)!, "proof-model")).CheckDataContract(snapshot, assertions),
            (snapshot, specification, expectedTypes) => new ModelHost(Path.Combine(Path.GetDirectoryName(snapshot)!, "proof-model")).CheckModuleSpecification(snapshot, specification, expectedTypes),
            new Anvil.Core.Delivery.CSharpRuntimeDelivery(request,
                Environment.GetEnvironmentVariable("ANVIL_CSHARP_RUNTIME_REGISTRATION")
                ?? Path.Combine(Anvil.Core.Delivery.BridgeAccess.DirectoryPath,"csharp-runtime.json"),Log),
            // Producer captures and re-attestation open their own read-only leases on the same Studio lane.
            StudioProducerAuthority.ForBridge(new BridgeClient(port, 330), Log),
            (basePath, jobPath, output, producers) => ApplyJob(basePath, jobPath, output, producers),
            // Merge order: defaults the native merge would drop are merged by a second pass of the same merge_from_oml.
            new MergePlanner(directory => new ModelHost(Path.Combine(directory, "order-model"))));
    }

    /// <summary>End-user roles (and opt-in demo accounts) of the O11 lane, by versioned manifest; see Anvil.Core.Access.
    ///   access plan  --manifest m.json [--module-base Module=oml]... [--producer Users=oml] [--create-accounts [--create-active]] [--work dir]
    ///   access apply --manifest m.json --words "..." [--execute | --prepare-only] [--plan plan.json] [--operation-id id] [--work dir] [--port n] [--deliver-work dir]
    ///   access verify (phase 2)
    /// Arguments are parsed strictly (Anvil.Core.Access.AccessArguments): the words are only ever the value of --words, so they
    /// can never switch apply to execution; only the separate flag --execute does, and the o11_access MCP tool never sends it.</summary>
    private static object AccessCmd(string[] args)
    {
        var parsed = Anvil.Core.Access.AccessArguments.Parse(args.Skip(1).ToArray());
        var lane = Environment.GetEnvironmentVariable("ANVIL_LANE") == "ss5" ? ".local/lane-ss5" : ".local";
        var work = Path.GetFullPath(parsed.Work ?? Path.Combine(lane, "access"));
        switch (parsed.Action)
        {
            case "plan":
                var bases = parsed.ModuleBases.ToDictionary(b => b.Key, b => Path.GetFullPath(b.Value), StringComparer.OrdinalIgnoreCase);
                return Anvil.Core.Access.AccessCommand.Plan(new(Path.GetFullPath(parsed.NeedManifest()), work, bases, JobSources.ParseBindings(parsed.Producers),
                    parsed.CreateAccounts, parsed.CreateActive), dir => new ModelHost(dir), Log);
            case "apply":
                var port = parsed.Port ?? (Environment.GetEnvironmentVariable("ANVIL_LANE") == "ss5" ? 4536 : 4516);
                var deliverWork = Path.GetFullPath(parsed.DeliverWork ?? Path.Combine(lane, "work"));
                // not AppContext.BaseDirectory: StudioAssemblies.Bind points it at the Studio installation
                var cli = "dotnet \"" + typeof(Program).Assembly.Location + "\"";
                // --execute runs each delivery on the port of its prepared argv (Apply refuses first when this call's port or
                // --deliver-work differ from it), so the Studio contacted is the one task.json records for --resume.
                return Anvil.Core.Access.AccessCommand.Apply(new(Path.GetFullPath(parsed.NeedManifest()), work, parsed.Words, parsed.Plan,
                    parsed.OperationId, parsed.Execute, deliverWork, port, cli), request => RunDelivery(request, request.BridgePort ?? port), Log);
            default:
                return Anvil.Core.Access.AccessCommand.Verify();
        }
    }

    private static object AppSessionCmd(string[] args)
    {
        Anvil.Core.Delivery.BridgeAccess.Initialize();
        var input = JsonNode.Parse(Console.In.ReadToEnd())?.AsObject() ?? throw new ArgumentException("App host requires JSON on stdin");
        var sessions = new Anvil.Core.Delivery.AppSessions(Anvil.Core.Delivery.BridgeAccess.DirectoryPath, input["trustedWorkspace"]?.GetValue<string>());
        string Id() => input["task_id"]?.GetValue<string>() ?? throw new ArgumentException("Missing task_id");
        return Need(args, "--action") switch
        {
            "capture" => sessions.Capture(input),
            "guard" => sessions.Guard(input),
            "authorize" => sessions.ConsumePermit(input["tool"]!.ToString(), input["arguments"]!.AsObject()),
            "context" => sessions.Context(Id()),
            "propose" => sessions.Propose(Id(), input["proposal"]!.AsObject()),
            "accept" => sessions.Accept(Id(), input["contract_hash"]!.ToString()),
            "prepare" => sessions.PrepareDelivery(Id()),
            "status" => sessions.Refresh(Id()),
            _ => throw new ArgumentException("Unknown app host action")
        };
    }

    private static Dictionary<string, string> ProducerBindings(string[] args) => Anvil.Core.Delivery.DeliverArguments.ProducerBindings(args);

    /// <summary>Funcoes built-in lidas do Studio: --out catalog/functions-<ver>.json [--docs docs/functions.md] | --find data | --name Substr</summary>
    private static object FunctionsCmd(string[] args)
    {
        if (Opt(args, "--name") is { } name)
            return FunctionCatalog.Get(name) is { } f ? f : new { notFound = name, closest = FunctionCatalog.Closest(name), hint = "veja docs/functions.md ou --find <parte do nome>" };
        if (Opt(args, "--find") is { } find)
            return FunctionCatalog.Find(find).Select(x => new { x.Name, x.Signature, x.Group, x.Logic, x.ClientSide, x.ServerAggregates, x.Description }).ToList();
        var outPath = Opt(args, "--out");
        var docs = Opt(args, "--docs");
        if (outPath == null && docs == null)
            return new { studio = FunctionCatalog.StudioVersion, count = FunctionCatalog.All.Count,
                groups = FunctionCatalog.All.GroupBy(x => x.Group).OrderBy(g => g.Key).ToDictionary(g => g.Key, g => g.Count()),
                usage = "--out <json> [--docs <md>] | --find <substr> | --name <Funcao>" };
        if (outPath != null)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outPath))!);
            File.WriteAllText(outPath, FunctionCatalog.ToJson());
        }
        if (docs != null)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(docs))!);
            File.WriteAllText(docs, FunctionCatalog.ToMarkdown());
        }
        return new { studio = FunctionCatalog.StudioVersion, count = FunctionCatalog.All.Count, outPath, docs };
    }

    /// <summary>Sonda de tipos de um assembly do Studio: --assembly ServiceStudio.Framework --filter MobileWidgets</summary>
    private static object TypesCmd(string[] args)
    {
        StudioAssemblies.Bind(Opt(args, "--studio-dir"));
        return FrameworkProbe.Types(StudioAssemblies.Directory, Need(args, "--assembly"), Need(args, "--filter"), int.TryParse(Opt(args, "--max"), out var m) ? m : 400);
    }

    // ---- args / output --------------------------------------------------

    private static string? Opt(string[] args, string name)
    {
        var i = Array.IndexOf(args, name);
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }

    private static string Need(string[] args, string name) => Opt(args, name) ?? throw new ArgumentException($"missing {name}");

    private static void Log(string s) => Console.Error.WriteLine(s);

    private static void Emit(JsonObject o) => Console.Out.WriteLine(o.ToJsonString(Json.Pretty));
}
