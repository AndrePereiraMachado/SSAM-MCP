using System.Diagnostics;
using OutSystems.Model;
using ServiceStudio.Model;

namespace Anvil.Core;

/// <summary>
/// Modelo do Studio sem GUI: carrega OML, valida, descreve, salva e recarrega. Tudo o que depende da plataforma
/// (prologo, load, save, release) passa por StudioAdapter.Runtime (WS0); o resto e so Model API V1.
/// </summary>
public sealed class ModelHost
{
    private readonly string _workDir;
    internal string WorkDirectory => Path.GetFullPath(_workDir);

    public ModelHost(string workDirectory)
    {
        _workDir = workDirectory;
        StudioAdapter.Runtime.Ensure(workDirectory);
    }

    public System.Text.Json.Nodes.JsonObject CheckModuleSpecification(string path, System.Text.Json.Nodes.JsonObject specification,
        System.Text.Json.Nodes.JsonObject? expectedTypes = null, Anvil.Core.Delivery.FrozenFrameworkDependencies? runtime = null)
    {
        var module = Load(path);
        try { return new ModelSession(module).CheckModuleSpecification(specification, expectedTypes, runtime); }
        finally { Release(module); }
    }

    public System.Text.Json.Nodes.JsonArray PlanModuleSpecification(string path, System.Text.Json.Nodes.JsonObject specification, Anvil.Core.Delivery.FrozenFrameworkDependencies? runtime = null)
    {
        var module = Load(path);
        try { return new ModelSession(module).PlanModuleSpecification(specification,runtime); }
        finally { Release(module); }
    }

    public System.Text.Json.Nodes.JsonArray PlanFrozenCSharp(string path, System.Text.Json.Nodes.JsonObject source,
        Anvil.Core.Delivery.FrozenCSharpCompilation compilation, Anvil.Core.Delivery.FrozenFrameworkDependencies? runtime = null)
    {
        var module = Load(path);
        try { return new ModelSession(module).PlanFrozenCSharp(source, compilation, runtime); }
        finally { Release(module); }
    }
    public System.Text.Json.Nodes.JsonObject CheckFrozenCSharp(string path, System.Text.Json.Nodes.JsonObject source,
        System.Text.Json.Nodes.JsonObject? expectedTypes, Anvil.Core.Delivery.FrozenCSharpCompilation compilation,
        Anvil.Core.Delivery.FrozenFrameworkDependencies? runtime = null)
    {
        var module = Load(path);
        try { return new ModelSession(module).CheckFrozenCSharp(source, expectedTypes, compilation, runtime); }
        finally { Release(module); }
    }

    public System.Text.Json.Nodes.JsonObject CheckDataContract(string path, System.Text.Json.Nodes.JsonArray assertions)
    {
        var module = Load(path);
        try { return new ModelSession(module).CheckDataContract(assertions); }
        finally { Release(module); }
    }

    public System.Text.Json.Nodes.JsonObject CheckDataSpecification(string path, System.Text.Json.Nodes.JsonObject specification,
        System.Text.Json.Nodes.JsonObject? expectedTypes = null)
    {
        var module = Load(path);
        try { return new ModelSession(module).CheckDataSpecification(specification, expectedTypes); }
        finally { Release(module); }
    }

    public System.Text.Json.Nodes.JsonArray PlanDataSpecification(string path, System.Text.Json.Nodes.JsonObject specification)
    {
        var module = Load(path);
        try { return new ModelSession(module).PlanDataSpecification(specification); }
        finally { Release(module); }
    }

    /// <summary>O censo completo de um OML (ver <see cref="ModelSession.Census"/>): carrega, percorre tudo e liberta.
    /// Vive aqui, e nao no CLI, porque so o kernel referencia os assemblies do Studio.</summary>
    public System.Text.Json.Nodes.JsonObject Census(string omlPath)
    {
        var module = Load(omlPath);
        try { return new ModelSession(module).Census(); }
        finally { Release(module); }
    }

    public ESpace Load(byte[] oml) => StudioAdapter.Runtime.Load(oml);

    public ESpace Load(string omlPath) => Load(File.ReadAllBytes(omlPath));

    /// <summary>Uma sessao sobre um modulo carregado e libertado aqui: quem chama so ve a ModelSession (tipo deste
    /// assembly), nunca o ESpace do Studio. Serve os testes das duas faixas, que ligam o Studio em runtime e nao
    /// referenciam os assemblies do modelo em compilacao.</summary>
    public T WithSession<T>(string omlPath, Func<ModelSession, T> work)
    {
        var espace = Load(omlPath);
        try { return work(new ModelSession(espace)); }
        finally { Release(espace); }
    }

    /// <summary>Liberta um modulo carregado. Um modulo carregado fica registado em estaticos do Studio ate ser fechado
    /// e libertado; sem isto um processo residente retem todos os modulos que ja carregou (medido no SS11: 3,5 GB
    /// apos 584 pedidos). O que exatamente libertar e da plataforma.</summary>
    public static Dictionary<string, int> Release(ESpace? espace) => StudioAdapter.Runtime.Release(espace);

    /// <summary>Elementos de referencia de um tipo (ex. IMobileBlockSignature) e o seu estado Hidden (dependencia indireta = true):
    /// para provar o item 17 sem expor tipos do Studio aos testes. Le o OML, devolve nome -> Hidden (null se o tipo nao tem a propriedade).</summary>
    public static IReadOnlyDictionary<string, bool?> HiddenReferences(byte[] oml, string typeName)
    {
        var espace = StudioAdapter.Runtime.Load(oml);
        try
        {
            var result = new Dictionary<string, bool?>(StringComparer.Ordinal);
            foreach (var o in ModelSession.Descendants((OutSystems.Model.IObjectSignature)espace, typeName))
            {
                var name = Prop(o, "Name") as string ?? "";
                if (name.Length == 0 || result.ContainsKey(name)) continue;
                result[name] = Prop(o, "Hidden") as bool?;
            }
            return result;
        }
        finally { Release(espace); }
    }

    /// <summary>Modulos ainda registados no Studio (o que o processo retem): contagem e nomes.</summary>
    public static (int Count, IReadOnlyList<string> Names) LoadedModules()
    {
        var t = typeof(ESpace).Assembly.GetTypes().FirstOrDefault(x => x.Name == "ESpaceInstances")
                ?? AppDomain.CurrentDomain.GetAssemblies().SelectMany(a => { try { return a.GetTypes(); } catch { return Type.EmptyTypes; } }).FirstOrDefault(x => x.Name == "ESpaceInstances");
        if (t?.GetProperty("LoadedESpaces", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static)?.GetValue(null) is not System.Collections.IEnumerable list)
            return (-1, Array.Empty<string>());
        var names = new List<string>();
        foreach (var o in list) names.Add(o is ESpace e ? e.Name : o?.GetType().Name ?? "?");
        return (names.Count, names);
    }

    public byte[] Save(ESpace espace) => StudioAdapter.Runtime.Save(espace);

    /// <summary>Carrega e descreve (validacao, objetos, referencias).</summary>
    public ModelSnapshot Inspect(byte[] oml)
    {
        var sw = Stopwatch.StartNew();
        var espace = Load(oml);
        try { return InspectLoaded(espace, sw.ElapsedMilliseconds); }
        finally { Release(espace); }
    }

    private static ModelSnapshot InspectLoaded(ESpace espace, long loadMs) => Describe(espace, loadMs);

    public ModelSnapshot Inspect(string omlPath) => Inspect(File.ReadAllBytes(omlPath));

    /// <summary>With a module index store, the capture's index is stored after the read when no valid one exists;
    /// a failure there is reported on stderr and never fails the read.</summary>
    public System.Text.Json.Nodes.JsonObject ReadModel(string omlPath, string path, Anvil.Reading.ReadingOptions options,
        Anvil.Reading.ModuleIndexStore? indexes = null)
    {
        options.Validate();
        var source = File.ReadAllBytes(omlPath);
        var module = Load(source);
        try {
            var reader = new KernelModelReader();
            var result = System.Text.Json.JsonSerializer.SerializeToNode(reader.Read((IObjectSignature)module, path, options))!.AsObject();
            var sourceSha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(source));
            result["sourceSha256"] = sourceSha256;
            result["identityScope"] = Anvil.Reading.ModuleIndex.IdentityScope;
            if (indexes != null && indexes.Load(sourceSha256) == null)
                try { indexes.Save(Anvil.Reading.ModuleIndex.Build((IObjectSignature)module, reader, module.Name, indexes.Lane, indexes.Adapter, sourceSha256, source.Length)); }
                catch (Exception error) { Console.Error.WriteLine("module index not stored: " + error.GetBaseException().Message); }
            return result;
        } finally { Release(module); }
    }

    /// <summary>The module digest of these bytes (ssam-digest), built from the loaded model; the caller stores it
    /// (Anvil.Reading.ModuleDigest.Ensure).</summary>
    public Anvil.Reading.ModuleDigest BuildDigest(byte[] source, string sourceSha256, string lane)
    {
        var module = Load(source);
        try { return Anvil.Reading.ModuleDigest.Build((IObjectSignature)module, new KernelModelReader(), lane, sourceSha256, source.Length); }
        finally { Release(module); }
    }

    /// <summary>The rich module index of these bytes (ssam-rich-index), built from the loaded model; the caller stores it
    /// (Anvil.Reading.ModuleRichIndex.Ensure).</summary>
    public Anvil.Reading.ModuleRichIndex BuildRich(byte[] source, string sourceSha256, string lane)
    {
        var module = Load(source);
        try { return Anvil.Reading.ModuleRichIndex.Build((IObjectSignature)module, new KernelModelReader(), lane, sourceSha256, source.Length); }
        finally { Release(module); }
    }

    /// <summary>Referencias que o modulo consome, lidas do OML (sem servidor).</summary>
    public IReadOnlyList<ModuleReference> References(byte[] oml)
    {
        var espace = Load(oml);
        try { return Describe(espace, 0).References; }
        finally { Release(espace); }
    }

    /// <summary>load -> verify -> save -> reload -> compare.</summary>
    public RoundTripResult RoundTrip(byte[] oml, string? savedPath = null)
    {
        var sw = Stopwatch.StartNew();
        var espace = Load(oml);
        var loadMs = sw.ElapsedMilliseconds;
        var original = Describe(espace, loadMs);

        var t0 = sw.ElapsedMilliseconds;
        var saved = Save(espace);
        var saveMs = sw.ElapsedMilliseconds - t0;
        if (savedPath != null)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(savedPath)!);
            File.WriteAllBytes(savedPath, saved);
        }

        t0 = sw.ElapsedMilliseconds;
        var espace2 = Load(saved);
        try
        {
            var reloaded = Describe(espace2, sw.ElapsedMilliseconds - t0);
            return new RoundTripResult(
                original, reloaded, oml.Length, saved.Length, saveMs,
                SameKey: original.Key == reloaded.Key,
                SameObjectCount: original.Objects == reloaded.Objects,
                SameValidation: Json.Serialize(original.Validation, false) == Json.Serialize(reloaded.Validation, false),
                SavedPath: savedPath);
        }
        finally { Release(espace2); Release(espace); }
    }

    public IReadOnlyList<MessageInfo> MessagesFromOml(string path)
    {
        var espace = Load(path);
        try { return Messages(espace); }
        finally { Release(espace); }
    }

    /// <summary>Uma leitura do Verify por fase; a identidade inclui os campos publicos usados pelo Studio.</summary>
    public static IReadOnlyList<MessageInfo> Messages(ESpace espace)
    {
        var result = new List<MessageInfo>();
        foreach (var m in espace.Verify())
        {
            var key = System.Text.Json.JsonSerializer.Serialize(new object?[] {
                m.Id, m.ObjectIdentifier?.GetObjectKey()?.ToString(), m.PropertyNames, m.MessageParameters });
            var definition = m.MessageDefinition;
            var text = definition.Message ?? "";
            var detail = definition.Detail?.Replace("\r", " ").Replace("\n", " ").Trim();
            if (!string.IsNullOrEmpty(detail) && !string.Equals(detail, text.Trim(), StringComparison.Ordinal)) text += " | " + detail;
            var owner = m.ObjectIdentifier?.TryGetAbstractObject();
            result.Add(new(m.Id, m.Type.ToString(), key, PathOf(owner), text)
                { OwnerKey = m.ObjectIdentifier?.GetObjectKey()?.ToString(), ScreenKey = ScreenKeyOf(owner) });
        }
        return result;
    }

    /// <summary>The screen (Reactive/Mobile or Traditional) that holds <paramref name="owner"/>, itself included; null outside screens.</summary>
    public static string? ScreenKeyOf(object? owner)
    {
        for (var o = owner as OutSystems.Model.IObjectSignature; o != null; o = o.Parent as OutSystems.Model.IObjectSignature)
            if (IsScreen(o)) return o.ObjectKey?.ToString();
        return null;
    }

    public static bool IsScreen(object o) => ModelSession.Implements(o, "IMobileScreen") || ModelSession.Implements(o, "IWebScreen");

    /// <summary>Erros nunca cortados; ordem recebida preservada dentro da severidade (novas primeiro); hints com orcamento proprio.</summary>
    public static IReadOnlyList<string> ValidationDetails(ESpace espace, int max = 60, IReadOnlyList<MessageInfo>? messages = null)
    {
        var all = messages ?? Messages(espace);
        var errors = all.Where(m => m.IsError).ToArray();
        var warnings = all.Where(m => !m.IsError).ToArray();
        var list = errors.Select(m => m.ToString()).ToList();
        var room = Math.Max(0, max - list.Count);
        list.AddRange(warnings.Take(room).Select(m => m.ToString()));
        if (warnings.Length > room) list.Add($"... {warnings.Length - room} more warnings not shown (of {warnings.Length})");
        list.AddRange(VerifyHints.Inline(errors.Concat(warnings.Take(room)), VerifyHints.Read()).Take(20));
        list.AddRange(ExpressionCheck.Hints(espace).Take(20));
        list.AddRange(ExpressionCheck.CurrentHints(espace, all));
        return list;
    }

    /// <summary>"Dono (Tipo) / Filho (Tipo) / ..." ate 6 niveis; sem Name usa Label; expressoes mostram o texto (ate 80 chars).</summary>
    public static string PathOf(object? owner)
    {
        var path = new List<string>();
        var o = owner as OutSystems.Model.IObjectSignature;
        while (o != null && path.Count < 6)
        {
            var kind = Kind(o.GetInterface()?.Name ?? o.GetType().Name);
            var name = Prop(o, "Name") as string;
            if (string.IsNullOrEmpty(name)) name = Prop(o, "Label") as string;
            string? text = null;
            if (o is IExpression ex) { try { text = ex.Text; } catch { text = null; } }
            if (!string.IsNullOrEmpty(text)) path.Add($"{kind} \"{(text.Length > 80 ? text[..80] + "..." : text)}\"");
            else path.Add(string.IsNullOrEmpty(name) ? kind : $"{name} ({kind})");
            o = o.Parent as OutSystems.Model.IObjectSignature;
        }
        path.Reverse();
        return string.Join(" / ", path);
    }

    /// <summary>"IInputParameter" -> "InputParameter" (so o prefixo I de interface; TrimStart comia os dois I).</summary>
    public static string Kind(string name) => name.Length > 1 && name[0] == 'I' && char.IsUpper(name[1]) ? name[1..] : name;

    /// <summary>Propriedade pelo nome no tipo concreto ou em qualquer interface: o Model API implementa varias propriedades
    /// (Label, Function...) explicitamente pela interface, invisiveis a GetType().GetProperty.</summary>
    public static object? Prop(object o, string name)
    {
        var t = o.GetType();
        var p = t.GetProperty(name);
        if (p != null) { try { return p.GetValue(o); } catch { return null; } }
        foreach (var i in t.GetInterfaces())
        {
            var ip = i.GetProperty(name);
            if (ip != null) { try { return ip.GetValue(o); } catch { return null; } }
        }
        return null;
    }

    /// <summary>Nos de uma action (nome, tipo, posicao) pelo Model API V1: prova de leitura do fluxo sem Studio.</summary>
    public IReadOnlyList<FlowNodeInfo> FlowNodesFromOml(byte[] oml, string actionName) => FlowNodes(Load(oml), actionName);

    public object RelayoutFromOml(byte[] oml, string outPath, IEnumerable<string>? actions, Action<string>? log)
    {
        var sw = Stopwatch.StartNew();
        var espace = Load(oml);
        try
        {
            var loadMs = sw.ElapsedMilliseconds;
            var results = FlowLayout.ApplyAll(espace, actions, log);
            var snap = Describe(espace, 0);
            var bytes = Save(espace);
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outPath))!);
            File.WriteAllBytes(outPath, bytes);
            return new { outPath, loadMs, totalMs = sw.ElapsedMilliseconds, objects = snap.Objects, isValid = snap.IsValid, messages = snap.Validation.Total, actions = results };
        }
        finally { Release(espace); }
    }

    public static IReadOnlyList<FlowNodeInfo> FlowNodes(ESpace espace, string actionName)
    {
        var es = (OutSystems.Model.IESpace)espace;
        var action = es.ServerActions.FirstOrDefault(a => string.Equals(a.Name, actionName, StringComparison.OrdinalIgnoreCase))
            ?? throw new KeyNotFoundException("server action not found: " + actionName);
        return action.Nodes.Select(n => new FlowNodeInfo(
            Prop(n, "Name") as string ?? Prop(n, "Label") as string ?? "",
            Kind(n.GetInterface()?.Name ?? n.GetType().Name),
            n.HorizontalPosition, n.VerticalPosition,
            n.Connectors.Select(c => c.Target?.GetType().GetProperty("Name")?.GetValue(c.Target) as string ?? "?").ToList())).ToList();
    }

    public static ModelSnapshot Describe(ESpace espace, long loadMs, IReadOnlyList<MessageInfo>? messages = null)
    {
        var sw = Stopwatch.StartNew();
        var byType = new Dictionary<string, int>();
        var sample = new List<string>();
        var total = 0;
        foreach (var m in messages ?? Messages(espace))
        {
            total++;
            var k = m.Type.ToString();
            byType[k] = byType.GetValueOrDefault(k) + 1;
            if (sample.Count < 12) sample.Add($"{m.Type}: {m.Id} @ {m.Path}");
        }
        var verifyMs = sw.ElapsedMilliseconds;

        var kinds = new Dictionary<string, int>();
        var objects = CountObjects(espace, kinds);
        var top = kinds.OrderByDescending(k => k.Value).Take(15).ToDictionary(k => k.Key, k => k.Value);

        var refs = new List<ModuleReference>();
        foreach (var r in espace.References)
        {
            var perType = new Dictionary<string, int>();
            var count = CountObjects(r, perType) - 1;
            refs.Add(new ModuleReference(r.Name, r.ReferenceKey?.ToString() ?? "", r.ReferenceKind.ToString(), r.ReferenceHash.ToString(), count, perType));
        }

        return new ModelSnapshot(
            espace.Name, espace.ESpaceType.ToString(), espace.Key.ToString(), espace.IsValid,
            objects, top, new ValidationSummary(total, byType, sample), refs, loadMs, verifyMs,
            espace.IsUserProvider, espace.UserProviderESpaceName, espace.UserProviderESpaceKey?.ToString());
    }

    private static int CountObjects(AbstractObject root, Dictionary<string, int> kinds)
    {
        var n = 0;
        var stack = new Stack<AbstractObject>(); stack.Push(root);
        while (stack.Count > 0)
        {
            var o = stack.Pop(); n++;
            var kn = o.GetType().Name; kinds[kn] = kinds.GetValueOrDefault(kn) + 1;
            try { foreach (var c in o.DirectChildren) stack.Push(c); } catch { }
        }
        return n;
    }
}
