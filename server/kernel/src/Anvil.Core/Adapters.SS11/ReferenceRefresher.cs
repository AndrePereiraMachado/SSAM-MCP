using System.Diagnostics;
using System.Reflection;
using System.Runtime.CompilerServices;
using OutSystems.Communication.ServiceCenter;
using OutSystems.MetaModel.Enumerations;
using OutSystems.Model;
using OutSystems.Model.Implementation;
using ServiceStudio.Model;
using ServiceStudio.Model.Interfaces;

namespace Anvil.Core;

public sealed record ReferenceStaleness(
    string Name, string Key, string Kind, string LocalHash, string? ServerHash, bool InCatalog, bool Stale, int LocalElements);

public sealed record RefreshOutcome(
    string ModuleName, string ModuleKey,
    IReadOnlyList<ReferenceStaleness> Before,
    bool RefreshApplied, bool Changed,
    IReadOnlyList<ReferenceStaleness> After,
    ValidationSummary ValidationBefore, ValidationSummary ValidationAfter,
    long CatalogMs, long RefreshMs, string? SavedOmlPath, PublishOutcome? Publish);

/// <summary>
/// Referencias sem GUI, nas duas direcoes do mapa (secao 3.7):
///   - Staleness: `Reference.ReferenceHash` (no OML) x `ReferenceInfo.SignatureHash` (catalogo do servidor).
///   - Refresh: assinaturas dos produtores (`GetReferenceDetails`) -> `IModuleSignature` ->
///     `ICommandServices.RefreshReferences` (Model API; interno, via reflexao), que roda o mesmo
///     `ReferencesManager.RefreshAllReferences` do Manage Dependencies com MockAggregatorPresenter.
/// </summary>
public static class ReferenceRefresher
{
    /// <summary>Compara os hashes locais com o catalogo do servidor (uma chamada, todos os produtores).</summary>
    public static IReadOnlyList<ReferenceStaleness> Staleness(HeadlessSession s, ESpace espace)
    {
        var catalog = s.ListReferenceable().ToDictionary(r => r.Key, r => r);
        var list = new List<ReferenceStaleness>();
        foreach (var r in espace.References)
        {
            var key = r.ReferenceKey?.ToString() ?? "";
            catalog.TryGetValue(key, out var info);
            var elements = 0; var st = new Stack<AbstractObject>(); st.Push(r);
            while (st.Count > 0) { var o = st.Pop(); elements++; try { foreach (var c in o.DirectChildren) st.Push(c); } catch { } }
            var local = r.ReferenceHash.ToString();
            var server = info?.SignatureHash;
            list.Add(new ReferenceStaleness(r.Name, key, r.ReferenceKind.ToString(), local, server, info != null,
                Stale: info != null && !string.Equals(Normalize(local), Normalize(server), StringComparison.OrdinalIgnoreCase),
                LocalElements: elements - 1));
        }
        return list;
    }

    private static string Normalize(string? g) => (g ?? "").Replace("{", "").Replace("}", "").Replace("-", "").ToLowerInvariant();

    /// <summary>
    /// Baixa as assinaturas atuais dos produtores referenciados e aplica o refresh no modelo
    /// (sem servidor alem do catalogo). Devolve o antes/depois; salva o OML se pedido.
    /// </summary>
    public static RefreshOutcome Refresh(HeadlessSession s, ModelHost host, ESpace espace, string? savedOmlPath = null,
        bool onlyStale = true, Action<string>? log = null)
    {
        var sw = Stopwatch.StartNew();
        var before = Staleness(s, espace);
        var validationBefore = ModelHost.Describe(espace, 0).Validation;
        var catalogMs = sw.ElapsedMilliseconds;
        foreach (var b in before) log?.Invoke($"  {b.Name,-32} {b.Kind,-9} elements={b.LocalElements,5} inCatalog={b.InCatalog} stale={b.Stale}");

        var targets = before.Where(b => b.InCatalog && (!onlyStale || b.Stale)).ToList();
        if (targets.Count == 0)
        {
            log?.Invoke("nothing to refresh");
            return new RefreshOutcome(espace.Name, espace.Key.ToString(), before, false, false, before, validationBefore, validationBefore, catalogMs, 0, null, null);
        }

        var signatures = new List<IModuleSignature>();
        foreach (var t in targets)
        {
            var info = s.GetReferenceSignature(t.Key, t.Kind);
            if (info == null)
            {
                log?.Invoke($"  no signature for {t.Name} ({t.Key} -> {s.LastRestKey}) rest={s.LastRestError}");
                continue;
            }
            signatures.Add(new ModuleSignatureAdapter(info));
            log?.Invoke($"  signature {t.Name}: {info.SignatureBinary.Length} bytes hash={info.SignatureHash}");
        }

        var t0 = sw.ElapsedMilliseconds;
        var changed = InvokeRefreshReferences(espace, signatures);
        var refreshMs = sw.ElapsedMilliseconds - t0;
        var after = Staleness(s, espace);
        var validationAfter = ModelHost.Describe(espace, 0).Validation;
        log?.Invoke($"refresh applied: changed={changed} in {refreshMs} ms; messages {validationBefore.Total} -> {validationAfter.Total}");

        if (savedOmlPath != null)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(savedOmlPath)!);
            File.WriteAllBytes(savedOmlPath, host.Save(espace));
        }
        return new RefreshOutcome(espace.Name, espace.Key.ToString(), before, true, changed, after, validationBefore, validationAfter, catalogMs, refreshMs, savedOmlPath, null);
    }

    /// <summary>Receita completa para CLI/runner: download -> load -> staleness -> refresh -> save [-> publish].</summary>
    public static RefreshOutcome RefreshModule(HeadlessSession s, ModelHost host, string moduleNameOrKey, string outDir,
        bool onlyStale = true, bool publish = false, Action<string>? log = null)
    {
        Directory.CreateDirectory(outDir);
        var module = s.FindModule(moduleNameOrKey) ?? throw new KeyNotFoundException($"module not found: {moduleNameOrKey}");
        var dl = s.Download(module, outDir);
        if (dl.Status != "ok" || dl.FilePath == null) throw new InvalidOperationException("download failed: " + dl.Status);
        var espace = host.Load(dl.FilePath);
        var r = Refresh(s, host, espace, Path.Combine(outDir, module.Name + ".refreshed.oml"), onlyStale, log);
        if (publish && r.RefreshApplied && r.SavedOmlPath != null)
        {
            var catalog = s.ListCatalogs().FirstOrDefault();
            var outcome = Publisher.Publish(s, File.ReadAllBytes(r.SavedOmlPath), module.ApplicationKey ?? throw new InvalidOperationException("module without application key"),
                catalog?.Id, "SSHeadless: refresh references", progress: log);
            r = r with { Publish = outcome };
        }
        return r;
    }

    /// <summary>Prepare a frozen extension dependency in the disposable model before business edits.
    /// RefreshReferences owns its native command and cannot be nested inside another command.</summary>
    internal static Reference ImportSnapshot(ESpace espace, NativeReferenceSnapshot snapshot, IReadOnlyList<NativeReferenceElement> requested)
    {
        // O11 imports legacy extension envelopes (version 1) and attested server captures (version 2, extension or
        // eSpace). The ODC public module signature (version 2 without attestation, `studio reference-snapshot`) belongs
        // to the ODC adapter (OdcReferenceImporter) and is never an O11 producer capture.
        if(snapshot.IsOdcPublicSignature)
            throw new NotSupportedException("O11 frozen signature import accepts extension envelopes and attested producer signatures only; an unattested module signature (ODC studio reference-snapshot) is not an O11 producer capture; capture it with `anvil signature`");
        var key=Keys.Parse(snapshot.ModuleKey);
        var reference=espace.References.SingleOrDefault(r=>r.ReferenceKey.Equals(key));
        // An empty selection refreshes an existing reference against the attested signature (A'); it never creates one.
        if(requested.Count==0 && (reference==null || !snapshot.RequiresServerAttestation))
            throw new ArgumentException("At least one producer element is required");
        // The recorded type closure travels with each requested element (e.g. the structure of an action output),
        // so the refresh fills existing stubs instead of depending on it to invent missing referenced types.
        var elements=snapshot.WithClosure(requested);
        var kind=snapshot.ModuleKind==OutSystems.Model.Enumerations.ReferenceKind.Extension ? ReferenceKind.Extension : ReferenceKind.eSpace;
        static bool Present(Reference source,NativeReferenceElement element)
            => NativeReferenceStubs.Find(source,element)!=null;
        if(reference==null && espace.References.Any(r=>r.Name.Equals(snapshot.Name,StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException("Reference name belongs to another producer: "+snapshot.Name);
        if(reference!=null && reference.ReferenceKind!=kind)throw new InvalidOperationException("Producer kind differs from the existing reference");
        // Native refresh updates exports already present as well as the newly requested stubs. Validate that entire
        // effective selection and its producer closure before mutation. An empty refresh changes only the existing exports,
        // so those are what it validates, never unrelated exports of the producer.
        var effective = requested.Select(element => NativeReferenceSnapshot.InterfaceOf(element.Kind) + ":@" + element.Key).ToList();
        // K1: the keys owned by other producers that these elements (and their closure) use; their owners join the refresh.
        var foreign = new List<string>();
        if (effective.Count > 0)
        {
            var resolution = NativeDependencyReader.ResolveServerSignature(snapshot.ModuleKey, snapshot.Name, snapshot.SignatureBinary, effective);
            if (resolution.Unresolved.Count > 0) throw new InvalidOperationException("Native reference refresh has unresolved same-producer signature dependencies");
            foreign.AddRange(resolution.Foreign);
        }
        var existingKeys = new List<string>();
        if (reference != null)
        {
            foreach (var existing in Exports(reference))
            {
                var generated = espace.GetSignatureForDebugPurposes(existing).First;
                // A model folder only groups exports; the reader validates it in the closure of the exports it holds.
                if (generated.FullSignature.Name.LocalName == "ReferenceModelFolder") continue;
                var family = NativeReferenceKinds.ForTag(generated.FullSignature.Name.LocalName)
                    ?? throw new InvalidOperationException("Unsupported existing export in native reference refresh");
                existingKeys.Add(family.Interface + ":@" + generated.OriginalKey);
            }
        }
        if (existingKeys.Count > 0)
        {
            var existingResolution = NativeDependencyReader.ValidateExistingServerImports(snapshot.ModuleKey, snapshot.Name, snapshot.SignatureBinary, existingKeys);
            if (existingResolution.Unresolved.Count > 0) throw new InvalidOperationException("Native reference refresh has unresolved same-producer signature dependencies");
            foreign.AddRange(existingResolution.Foreign);
        }
        var imported = Imported.GetOrCreateValue(espace);
        if(reference?.ReferenceHash==snapshot.SignatureHash && elements.All(e=>Present(reference,e))) { imported.Add(snapshot); return reference; }
        // A25: the themes a signature cannot import, all at once and before the model is touched.
        if(NativeReferenceStubs.Themes(snapshot,elements,e=>reference!=null && Present(reference,e)) is {Count:>0} themes)throw Preflight.ProducerSignatureMissing.Refusal(snapshot.Name,themes);
        Publisher.Mutate(espace,"Prepare native producer reference",module=>
        {
            reference??=new Reference(espace,snapshot.Name) {ReferenceKey=key,ReferenceKind=kind};
            NativeReferenceStubs.Add(reference,snapshot,elements);
            reference.ReferenceHash=Guid.Empty;
        });
        // K1 (atritos 3): ONE native refresh with this signature, every signature already imported into this model in this
        // execution, and the linked signatures of the producers that own the foreign types of these elements (transitively).
        // The Studio resolves a cross-producer type only against the signatures of the same refresh (offline proof
        // C:\t\verif-d1: one signature per refresh drops or fails the element; all of them in one refresh keeps it), so the
        // last import of an execution is the combined refresh of all of them. Refreshing a signature already present is a
        // native no-op. Refresh uses IModuleSignature.Name as the local reference label; identity is the producer key, and
        // retaining each existing label preserves a consumer alias.
        var owners = LinkedOwners(snapshot, foreign, imported);
        var call = new List<NativeReferenceSnapshot> { snapshot };
        foreach (var other in imported.Snapshots.Concat(owners))
            if (!call.Any(c => Keys.Parse(c.ModuleKey).Equals(Keys.Parse(other.ModuleKey)))) call.Add(other);
        var signatures = call.Select(s => (IModuleSignature)new NativeReferenceCapture.SnapshotSignature(s with {
            Name = espace.References.SingleOrDefault(r => r.ReferenceKey.Equals(Keys.Parse(s.ModuleKey)))?.Name ?? s.Name })).ToList();
        try { InvokeRefreshReferences(espace, signatures); }
        catch (Exception ex) when (Unwrap(ex) is InvalidOperationException)
        {
            // The native refresh asserts ("Condition is false") on a type of a producer that is not in the refresh: the cause is
            // the missing owner, named with every element that needs it, never the assertion.
            var named = elements.Select(e => ForeignProblem(espace, snapshot, e, call)).OfType<System.Text.Json.Nodes.JsonObject>().ToList();
            if (named.Count == 0) throw;
            throw Preflight.ProducerSignatureMissing.Refusal(snapshot.Name, named);
        }
        foreach (var included in call) imported.Add(included);
        // A25: what the native refresh did not keep, every element at once, checked after the combined refresh. Cause foreign
        // when the element uses a type of a producer that was not in the refresh (nothing to publish); unpublished otherwise.
        reference=espace.References.SingleOrDefault(r=>r.ReferenceKey.Equals(key));
        var dropped=elements.Where(e=>reference==null || !Present(reference,e)).Select(e=>ForeignProblem(espace,snapshot,e,call) ?? Preflight.ProducerSignatureMissing.Problem(
            NativeReferenceSnapshot.InterfaceOf(e.Kind)+":"+e.Name,snapshot.Name,"unpublished",
            (reference==null ? "Requested elements are absent from the native producer signature: " : "Element is absent from the native producer signature: ")+e.Name+" of "+snapshot.Name,
            $"publish {snapshot.Name} with {e.Name} Public, then capture it again (o11_dependencies list shows what {snapshot.Name} publishes)")).ToList();
        if(dropped.Count>0)throw Preflight.ProducerSignatureMissing.Refusal(snapshot.Name,dropped);
        if(reference==null)throw new InvalidOperationException("Requested elements are absent from the native producer signature: "+snapshot.Name);
        if(reference.ReferenceHash!=snapshot.SignatureHash)throw new InvalidOperationException("Native signature hash was not refreshed");
        return reference;
        static IEnumerable<ITopLevelReferenceElement> Exports(AbstractObject root)
        {
            foreach (var child in root.DirectChildren)
            {
                if (child is ITopLevelReferenceElement export) yield return export;
                foreach (var nested in Exports(child)) yield return nested;
            }
        }
    }

    /// <summary>K1: the producer signatures already in a native refresh of one model during this execution, one per producer
    /// key (the latest wins). Kept per ESpace instance: a new model starts empty, so a resident worker never mixes jobs.</summary>
    private sealed class ImportRegistry
    {
        private readonly List<NativeReferenceSnapshot> _snapshots = [];
        public IReadOnlyList<NativeReferenceSnapshot> Snapshots => _snapshots;
        public void Add(NativeReferenceSnapshot snapshot)
        {
            var key = Keys.Parse(snapshot.ModuleKey);
            _snapshots.RemoveAll(s => Keys.Parse(s.ModuleKey).Equals(key));
            _snapshots.Add(snapshot);
        }
    }
    private static readonly ConditionalWeakTable<ESpace, ImportRegistry> Imported = new();

    /// <summary>K1: the linked signatures (<see cref="NativeReferenceSnapshot.Linked"/>, then those already imported into the
    /// model) of the producers that own the foreign keys of an import, followed through each owner's own foreign keys for
    /// the elements reached. A foreign key whose owner is not available is left to the refresh and to the check after it.</summary>
    private static List<NativeReferenceSnapshot> LinkedOwners(NativeReferenceSnapshot snapshot, IEnumerable<string> foreign, ImportRegistry imported)
    {
        var self = Keys.Parse(snapshot.ModuleKey);
        var available = NativeReferenceSnapshot.Linked.Concat(imported.Snapshots).Where(s => !Keys.Parse(s.ModuleKey).Equals(self)).ToList();
        var owners = new List<NativeReferenceSnapshot>();
        var pending = new Queue<string>(foreign); var seen = new HashSet<string>(StringComparer.Ordinal);
        while (pending.Count > 0)
        {
            var global = pending.Dequeue();
            if (!seen.Add(global) || ForeignKey(global) is not { } parsed || parsed.Owner.Equals(self)) continue;
            var owner = available.FirstOrDefault(s => Keys.Parse(s.ModuleKey).Equals(parsed.Owner));
            if (owner == null) continue;
            if (!owners.Contains(owner)) owners.Add(owner);
            foreach (var next in ForeignOf(owner, parsed.Object)) pending.Enqueue(next);
        }
        return owners;
    }

    /// <summary>The foreign keys of one element of a producer signature, named by its original key; none when the element is
    /// not a visible export of that signature (the refresh decides).</summary>
    private static IReadOnlyList<string> ForeignOf(NativeReferenceSnapshot owner, string objectKey)
    {
        try
        {
            var element = NativeDependencyReader.ListServerSignature(owner.ModuleKey, owner.Name, owner.SignatureBinary)
                .FirstOrDefault(e => e.Kind != "unsupported" && e.OriginalKey == objectKey);
            return element == null ? [] : NativeDependencyReader.ResolveServerSignature(owner.ModuleKey, owner.Name, owner.SignatureBinary,
                [element.Type + ":@" + element.OriginalKey]).Foreign;
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException) { return []; }
    }

    /// <summary>A native global key "&lt;owner key&gt;*&lt;object key&gt;" (GlobalObjectKey) split; null when it is not one.</summary>
    private static (OutSystems.ObjectKeys.ObjectKey Owner, string Object)? ForeignKey(string global)
    {
        var star = global.IndexOf('*');
        if (star <= 0 || star == global.Length - 1) return null;
        try { return (Keys.Parse(global[..star]), global[(star + 1)..]); }
        catch (Exception ex) when (ex is FormatException or ArgumentException) { return null; }
    }

    /// <summary>The owners (producer keys) of these foreign keys whose signature is not in the refresh.</summary>
    private static List<OutSystems.ObjectKeys.ObjectKey> Missing(IEnumerable<string> foreign, IReadOnlyList<NativeReferenceSnapshot> call)
    {
        var inCall = call.Select(s => Keys.Parse(s.ModuleKey)).ToList();
        var missing = new List<OutSystems.ObjectKeys.ObjectKey>();
        foreach (var global in foreign)
            if (ForeignKey(global) is { } parsed && !inCall.Any(k => k.Equals(parsed.Owner)) && !missing.Any(k => k.Equals(parsed.Owner))) missing.Add(parsed.Owner);
        return missing;
    }

    /// <summary>I5 cause foreign: the element uses a type of a producer whose signature was not in the refresh (not linked in
    /// this execution). Null when every owner of the element's foreign types was in the refresh. Never a publication fix:
    /// nothing is missing from the producer, the owner is missing from the execution.</summary>
    private static System.Text.Json.Nodes.JsonObject? ForeignProblem(ESpace espace, NativeReferenceSnapshot snapshot, NativeReferenceElement element,
        IReadOnlyList<NativeReferenceSnapshot> call)
    {
        IReadOnlyList<string> foreign;
        try { foreign = NativeDependencyReader.ResolveServerSignature(snapshot.ModuleKey, snapshot.Name, snapshot.SignatureBinary,
                [NativeReferenceSnapshot.InterfaceOf(element.Kind) + ":@" + element.Key]).Foreign; }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException) { return null; }
        var missing = Missing(foreign, call);
        if (missing.Count == 0) return null;
        var names = missing.Select(owner => OwnerName(espace, owner)).ToList();
        // Unnamed (the consumer does not reference it): only its key is known here; the delivery's capture by key names it.
        var named = names.Select((name, i) => !name.Equals(missing[i].ToString(), StringComparison.Ordinal)).ToList();
        var labels = names.Select((name, i) => named[i] ? name : "the producer with key " + name).ToList();
        var bindings = names.Select((name, i) => named[i] && new string(name.Where(c => char.IsLetterOrDigit(c) || c == '_').ToArray()) is { Length: > 0 } b
            && !char.IsDigit(b[0]) ? b : "<Owner>").ToList();
        var several = labels.Count > 1;
        // Every owner at once: one correction binds or captures all of them.
        var problem = Preflight.ProducerSignatureMissing.Problem(NativeReferenceSnapshot.InterfaceOf(element.Kind) + ":" + element.Name, snapshot.Name, "foreign",
            $"{element.Name} of {snapshot.Name} uses types of {string.Join(" and ", labels)}, whose signature{(several ? "s are" : " is")} not linked in this execution, so the native refresh cannot resolve them",
            $"o11_deliver captures {string.Join(" and ", labels)} by itself (captureProducers); outside a delivery, bind {(several ? "each capture" : "its capture")} too: "
            + string.Join(" ", labels.Select((label, i) => $"--producer {bindings[i]}=<.avsig of {label}>"))
            + string.Concat(names.Where((_, i) => named[i]).Select(name => $" (o11_dependencies capture --producer {name})"))
            + (named.Contains(false) ? " (o11_environment referenceable names a producer by its key)" : ""));
        problem["owner"] = names[0];
        if (several) problem["owners"] = new System.Text.Json.Nodes.JsonArray(names.Select(n => (System.Text.Json.Nodes.JsonNode)n).ToArray());
        return problem;
    }

    /// <summary>The name of a producer by its key: the consumer's reference label, (System) for the Service Center eSpace,
    /// else the key itself.</summary>
    private static string OwnerName(ESpace espace, OutSystems.ObjectKeys.ObjectKey owner)
        => espace.References.FirstOrDefault(r => r.ReferenceKey != null && r.ReferenceKey.Equals(owner))?.Name
           ?? (owner.Equals(OutSystems.RuntimeCommon.Constants.ServiceCenterESpaceKey) ? "(System)" : owner.ToString());

    private static Exception Unwrap(Exception ex)
    {
        while (ex is TargetInvocationException { InnerException: { } inner }) ex = inner;
        return ex;
    }

    /// <summary>ICommandServices e interno no OutSystems.Model.V1: ServicesProvider.Instance.GetService&lt;ICommandServices&gt;().RefreshReferences(...)</summary>
    private static bool InvokeRefreshReferences(ESpace espace, IEnumerable<IModuleSignature> signatures)
    {
        var v1 = typeof(IESpace).Assembly;
        var spType = v1.GetType("OutSystems.Model.ServicesProvider") ?? throw new InvalidOperationException("ServicesProvider not found");
        var instance = spType.GetProperty("Instance", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)!.GetValue(null)!;
        var svcType = v1.GetType("OutSystems.Model.ICommandServices") ?? throw new InvalidOperationException("ICommandServices not found");
        var getService = instance.GetType().GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
            .First(m => m.Name == "GetService" && m.IsGenericMethodDefinition && m.GetParameters().Length == 0)
            .MakeGenericMethod(svcType);
        var svc = getService.Invoke(instance, null) ?? throw new InvalidOperationException("ICommandServices unavailable");
        var refresh = svc.GetType().GetMethod("RefreshReferences", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
            ?? throw new InvalidOperationException("RefreshReferences not found");
        var result = refresh.Invoke(svc, new object?[] { espace, signatures.ToList(), null, null });
        return result is bool b && b;
    }

    /// <summary>ReferenceInfo do Service Center -> IModuleSignature do Model API.</summary>
    private sealed class ModuleSignatureAdapter : IModuleSignature
    {
        private readonly ReferenceInfo _r;
        public ModuleSignatureAdapter(ReferenceInfo r) => _r = r;
        public string ModuleKey => _r.Key;
        public string ApplicationKey => _r.AppKey;
        // IModuleSignature usa os enums do proprio OutSystems.Model.V1 (nao os do MetaModel): mapear por nome.
        public OutSystems.Model.Enumerations.ReferenceKind ModuleKind =>
            Enum.TryParse<OutSystems.Model.Enumerations.ReferenceKind>(string.Equals(_r.Kind, "Extension", StringComparison.OrdinalIgnoreCase) ? "Extension" : "eSpace", true, out var k) ? k : default;
        public OutSystems.Model.Enumerations.SegmentationKind ModuleType =>
            Enum.TryParse<OutSystems.Model.Enumerations.SegmentationKind>(_r.RuntimeKind.ToString(), true, out var t) ? t : default;
        public string Name => _r.Name;
        public string Description => _r.Description ?? "";
        public byte[] Icon => _r.Icon ?? Array.Empty<byte>();
        public string JQueryVersion => _r.JQueryVersion ?? "";
        public string ExtensibilityConfigurations => _r.ExtensibilityConfiguration ?? "";
        public string DatabaseName => "";
        public Guid SignatureHash => _r.SignatureHash;
        public byte[] SignatureBinary => _r.SignatureBinary;
    }
}
