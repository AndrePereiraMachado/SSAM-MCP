using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Reading;
using OutSystems.Model;
using OutSystems.Model.Enumerations;
using OutSystems.Model.Expressions;
using OutSystems.Model.UI.Mobile;
using OutSystems.ModelAPILoader;

// Read-only inspection of a module file, headless: no Studio, no transaction, nothing written to the model.
// Usage: ODC3.Builder inspect <model.oml> [Kind:Name/Kind:Name] [--depth N] [--max N] [--all] [--full] [--out file.json]
//   no path  -> the module map: names per element kind, screens per flow, dependencies
//   a path   -> the resolved element's subtree, N levels deep (default 3), with its properties as text;
//               expressions show their text, references show Kind:Name. Audit properties are hidden unless --all.
//   --full   -> property text is not clipped at 400 characters. The clip keeps a subtree readable, but it hides the
//               body of a JavaScript node or a long stylesheet, which is exactly what a change to one has to read.
// Path syntax is ModelPath's: "MobileScreen:Backoffice", "ServerAction:GetQuotes/AssignNode:*", "Entity:Carrier".
internal static class Inspect {
    private static bool readConfigured;
    public static IReadSnapshot OpenSnapshot(byte[] source) {
        const string author = "inspect@ssam-hybrid-odc";
        if (!readConfigured) {
            Loader.SetConfiguration(new Configuration { DeveloperId = author, StorageStrategy = FileStorageStrategy.InMemory, UseSharedCache = false });
            readConfigured = true;
        }
        var model = LoadESpace(Loader.ModelServicesInstance, source, author);
        return new ReadSnapshot<IModelObject>(model, new OdcReader(), model.Name, () => model.Dispose(), (n, file) => Map((IESpace)n, file));
    }
    // A Mobile UI app requires the MobileUI model plugin: the reader (ssam_map, studio_inspect) takes it from the ODC
    // Studio's plugin cache, as the kernel does, and a missing one is refused in one line that names it.
    private static IESpace LoadESpace(IModelServices services, byte[] source, string author) {
        Anvil.Core.OdcModelPlugins.Register(services);
        try { return services.LoadESpace(source, loadFlags: LoadFlags.SkipUpgrades, developerId: author); }
        catch (Exception error) when (Anvil.Core.OdcModelPlugins.Refusal(error, "the module") is { } refusal) { throw refusal; }
    }
    public static int Run(string[] args, string author) {
        if (args.Length == 0 || args[0].StartsWith("--")) throw new ArgumentException("Usage: inspect <model.oml> [Kind:Name/Kind:Name] [--depth N] [--max N] [--all] [--full] [--out file.json]");
        var modelPath = Path.GetFullPath(args[0]);
        var path = PositionalPath(args);
        // "/" is the model root: the whole module as one tree, for when a refactor has to query many elements and
        // reloading the model per element costs more than the file. An empty argument cannot be used for this:
        // PowerShell drops it before the process sees it.
        if (path == "/") path = "";
        var options = ReadingOptions.Parse(args);
        var outFile = Option(args, "--out");
        // Orcamento de saida. O inspect montava a arvore inteira e deixava o transporte rejeita-la: na sessao de
        // 17/09 sao 26 estouros de token, e o MESMO alvo com os MESMOS parametros passava quando ia para ficheiro
        // (29 chamadas, zero estouros) e rebentava quando vinha por stdout, cinco vezes seguidas a 1,87 MB.
        // `--depth` e `--max` nao servem para isto: baixar depth e subir max chegou a AUMENTAR a saida (259.618
        // contra 253.709). O que decide e o tamanho, por isso e o tamanho que se controla.
        var budget = int.TryParse(Option(args, "--budget"), out var b) ? b : 60_000;
        var source = File.ReadAllBytes(modelPath);
        var sourceSha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(source));
        // A listing the module index answers exactly comes from the stored index of these bytes, before any Studio
        // assembly is configured; otherwise the model answers, as before, and stores the index.
        var indexes = ModuleIndexStore.Default();
        var index = ModuleIndex.Answerable(path ?? "/", options, null) ? indexes?.Load(sourceSha256) : null;
        var (result, modelName) = index?.Query(path ?? "/", options) is { } indexed
            ? (Identify(indexed, index.ModuleName, sourceSha256), index.ModuleName)
            : Load(source, sourceSha256, modelPath, path, options, author, indexes);
        var json = JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
        if (outFile == null) {
            // Sem --out o comportamento fica EXACTAMENTE como estava: ha scripts e maos humanas que dependem de
            // receber o JSON cru em stdout, e mudar isso partia-os sem aviso.
            Console.WriteLine(json);
            return 0;
        }
        var destino = Path.GetFullPath(outFile);
        var pasta = Path.GetDirectoryName(destino);
        if (!string.IsNullOrEmpty(pasta)) Directory.CreateDirectory(pasta);
        File.WriteAllText(destino, json);
        // UMA linha, com chaves fixas, sempre as mesmas. Antes havia duas formas conforme o ramo que corria, e
        // quem lia do outro lado tinha de adivinhar qual tinha calhado. Uma linha so tambem deixa o leitor
        // parsear a ULTIMA linha nao vazia e ignorar o que o loader do .NET tenha escrito antes.
        var cabe = json.Length <= budget;
        var envelope = new Dictionary<string, object?> {
            ["ok"] = true,
            ["model"] = modelName,
            ["path"] = path ?? "/",
            ["bytes"] = System.Text.Encoding.UTF8.GetByteCount(json),
            ["characters"] = json.Length,
            ["budget"] = budget,
            ["inline"] = cabe,
            ["out"] = destino,
            ["sourceSha256"] = sourceSha256,
            ["data"] = cabe ? result : null,
        };
        Console.WriteLine(JsonSerializer.Serialize(envelope, new JsonSerializerOptions {
            WriteIndented = false, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping }));
        return 0;
    }

    // Every Studio type of a cold inspect lives here, so Run answers from the module index without binding one.
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static (object Result, string Model) Load(byte[] source, string sourceSha256, string modelPath, string? path,
        ReadingOptions options, string author, ModuleIndexStore? indexes) {
        Loader.SetConfiguration(new Configuration { DeveloperId = author, StorageStrategy = FileStorageStrategy.InMemory, UseSharedCache = false });
        var services = Loader.ModelServicesInstance;
        using var model = LoadESpace(services, source, author);
        if (path == null && !options.IsQuery && options.Properties == null && !options.Usages) return (Map(model, modelPath), model.Name);
        var reader = new OdcReader();
        var reading = JsonSerializer.SerializeToNode(reader.Read(model, path ?? "/", options))!.AsObject();
        if (indexes != null && indexes.Load(sourceSha256) == null)
            try { indexes.Save(ModuleIndex.Build<IModelObject>(model, reader, model.Name, indexes.Lane, indexes.Adapter, sourceSha256, source.Length)); }
            catch (Exception error) { Console.Error.WriteLine("module index not stored: " + error.GetBaseException().Message); }
        return (Identify(reading, model.Name, sourceSha256), model.Name);
    }
    private static JsonObject Identify(JsonObject reading, string model, string sourceSha256) {
        reading["model"] = model;
        reading["sourceSha256"] = sourceSha256;
        reading["identityScope"] = ModuleIndex.IdentityScope;
        return reading;
    }

    private static string? Option(string[] args, string name) { var i = Array.IndexOf(args, name); return i >= 0 && i + 1 < args.Length ? args[i + 1] : null; }
    private static string Describe(object? type) => type is IModelObject o ? ModelPath.Kind(o) + ":" + o.DisplayName : type?.ToString() ?? "null";
    private static string[] Referrers(IModelObject node) => node.Referrers.Select(r => ModelPath.Describe(r) + (r.Parent != null ? " in " + ModelPath.Describe(r.Parent) : "")).Take(10).ToArray();
    private static string? PositionalPath(string[] args) {
        string? result = null;
        for (var i = 1; i < args.Length; i++) {
            var arg = args[i];
            if (arg is "--depth" or "--max" or "--out" or "--budget" or "--kind" or "--name" or "--text" or "--offset" or "--properties" or "--scope") {
                if (++i >= args.Length || args[i].StartsWith("--"))
                    throw new ArgumentException("Missing value for " + arg);
            } else if (arg is "--all" or "--full" or "--usages" or "--include-internal") { }
            else if (arg.StartsWith("--")) throw new ArgumentException("Unknown inspect option: " + arg);
            else if (result != null) throw new ArgumentException("inspect accepts only one model path: " + arg);
            else result = arg;
        }
        return result;
    }

    private static object Map(IESpace m, string file) {
        IEnumerable<string> Names<T>(IEnumerable<T> items) where T : IModelObject => items.Select(i => i.DisplayName).OrderBy(n => n, StringComparer.OrdinalIgnoreCase);
        return new {
            module = m.Name, key = m.Key.ToString(), kind = m.Kind.ToString(), file,
            dependencies = m.Dependencies.Select(r => r.Name + " r" + r.Revision).ToArray(),
            entities = m.Entities.Select(e => new { name = e.Name, kind = ModelPath.Kind(e), attributes = e.Attributes.Select(a => a.Name).ToArray() }).OrderBy(e => e.name).ToArray(),
            structures = m.Structures.Select(s => new { name = s.Name, attributes = s.Attributes.Select(a => a.Name).ToArray() }).OrderBy(s => s.name).ToArray(),
            serverActions = Names(m.ServerActions).ToArray(), serviceActions = Names(m.ServiceActions).ToArray(), clientActions = Names(m.ClientActions).ToArray(),
            flows = m.MobileFlows.Select(f => new { flow = f.Name, screens = Names(Authoring.Walk(f).OfType<IMobileScreen>()).ToArray(), blocks = Names(Authoring.Walk(f).OfType<IMobileBlock>()).ToArray() }).ToArray(),
            themes = Names(m.MobileThemes).ToArray(), timers = Names(m.Timers).ToArray(), globalEvents = Names(m.GlobalEvents).ToArray(), scripts = Names(m.Scripts).ToArray(),
            roles = Names(m.Roles).ToArray(), siteProperties = Names(m.SiteProperties).ToArray(), clientVariables = Names(m.ClientVariables).ToArray(),
            userExceptions = Names(m.UserExceptions).ToArray(), integrations = Names(m.Integrations).ToArray(), processes = Names(m.Processes).ToArray(),
            // Types the model created on its own (aggregate outputs, list variables). Orphans are the ones nothing refers to any more.
            anonymousStructures = m.AnonymousStructures.Select(s => new { key = s.Key.ToString(), attributes = s.Attributes.Select(a => a.Name + ":" + Describe(a.DataType)).ToArray(), referrers = Referrers(s), referrersTotal = s.Referrers.Count(), referrersOmitted = Math.Max(0, s.Referrers.Count() - 10) }).ToArray(),
            listTypes = m.ListTypes.Select(l => new { key = l.Key.ToString(), elementType = Describe(l.ElementType), referrers = Referrers(l), referrersTotal = l.Referrers.Count(), referrersOmitted = Math.Max(0, l.Referrers.Count() - 10) }).ToArray(),
            hint = "inspect <model.oml> \"MobileScreen:<Name>\" --depth 4 shows a screen's variables, aggregates, actions and widgets; \"ServerAction:<Name>\" --depth 3 shows an action's parameters and flow."
        };
    }

    private sealed class OdcReader : ModelReader<IModelObject> {
        protected override IEnumerable<IModelObject> Referrers(IModelObject node) => node.Referrers;
        protected override IEnumerable<IModelObject> Children(IModelObject node) => node.Children;
        protected override IModelObject? Parent(IModelObject node) => node.Parent;
        protected override string Key(IModelObject node) => node.Key.ToString() ?? "";
        protected override string Kind(IModelObject node) => ModelPath.Kind(node);
        private static string? Property(IModelObject node, string name) {
            try { return node.Descriptor.Properties.FirstOrDefault(p => p.Name == name)?.GetValue(node)?.ToString(); }
            catch { return null; }
        }
        protected override string Name(IModelObject node) => Property(node, "Name") ?? "";
        protected override string? Label(IModelObject node) => Property(node, "Label") ?? node.DisplayName;
        private static readonly System.Collections.Concurrent.ConcurrentDictionary<Type, IReadOnlySet<string>> KindNameSets = new();
        protected override IReadOnlySet<string> KindNames(IModelObject node) => KindNameSets.GetOrAdd(node.GetType(), type =>
            type.GetInterfaces().SelectMany(t => new[] { t.Name, t.FullName }).OfType<string>().ToHashSet(StringComparer.Ordinal));
        protected override IEnumerable<(string Name, Func<object?> Read)> Properties(IModelObject node) =>
            node.Descriptor.Properties.Select(p => (p.Name, (Func<object?>)(() => p.GetValue(node))));
        protected override Func<object?>? FindProperty(IModelObject node, string name) {
            var named = node.Descriptor.Properties.Where(p => p.Name == name).Take(2).ToArray();
            return named.Length switch { 0 => null, 1 => () => named[0].GetValue(node), _ => throw new InvalidOperationException("Property listed twice: " + name) };
        }
        protected override string? Expression(object value) => value is IExpression expression ? expression.Text : null;
    }
}
