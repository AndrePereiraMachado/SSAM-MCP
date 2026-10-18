using System.Text.Json.Nodes;
using OutSystems.ObjectKeys;
using ServiceStudio.Common;
using ServiceStudio.Merge;
using MatchType = ServiceStudio.Merge.MatchType;
using ServiceStudio.Model;
using ServiceStudio.Model.Interfaces;
using ServiceStudio.Presenter;
using ServiceStudio.Presenter.AddRemoveReferences;
using ServiceStudio.ServerCommunications;
using ServiceStudio.ServerCommunications.API;

namespace Anvil.Core;

/// <summary>One producer of a Manage Dependencies request: the producer by key (preferred) or by name, the elements to
/// reference ("Type:Name", "Type:@originalKey", "Name" or "@originalKey", as a job's reference op names them) and whether
/// its reference is brought to the producer's published signature (the Refresh of Manage Dependencies).</summary>
public sealed record DependencyRequest(string? Producer, string? ProducerKey, IReadOnlyList<string> Elements, bool Published);

/// <summary>
/// fix-ext-refs (2026-10-16): the Service Studio's own Manage Dependencies on an open module, without its dialog. It is what
/// the dialog's Apply runs (ServiceStudio.Presenter 11.55, ReferencesManager): InitializeAddReferences loads the published
/// signatures of the named producers from the Studio's own catalog (IReferencesService of the signed-in Studio: the server's
/// signature of an eSpace, of (System), and of an Extension, whose signature comes from its published extension reference,
/// never from an OML); SetIsChecked checks each element (the Studio adds what it depends on); Refresh brings an existing
/// reference to the published signature (CommitRefreshReferences copies ReferenceHash only for a root it refreshes); and
/// CommitRefreshReferences merges it all into the module. One Studio command ("Manage Dependencies"), opened by SSAM
/// (QuietCommand, fam-deps R1): Ctrl+Z undoes it, nothing is published.
/// All or nothing: every element is resolved, checked and verified before the commit; any problem (a producer that is not
/// referenceable, an element the published signature does not have, an element the Studio refuses in this module kind)
/// rolls the command back and comes back at once, every problem with its fix. The live Refresh References
/// (RefreshSpecificReferences) never adds an element: it only refreshes references the Studio decorates as outdated.
/// The bridge runs <see cref="Apply"/> on the live module (refresh_references with add, capability refresh_references:add);
/// <see cref="ApplyOffline"/> runs the same code headless on an OML with captured signatures (tests, offline proofs).
/// </summary>
public static class ManageDependencies
{
    /// <summary>The Studio's own name of the command (ReferencesManager.AddRemoveReferencesCommandName).</summary>
    public const string CommandName = "Manage Dependencies";
    public const string Code = "REFERENCES_NOT_ADDED";

    /// <summary>The requests of the bridge parameters: add [{producer?, producer_key?, elements[]}] and published (all of
    /// them), plus the producers/producer_keys named without elements when published (aligned only).</summary>
    public static IReadOnlyList<DependencyRequest> Requests(JsonObject parameters)
    {
        var published = parameters["published"]?.GetValue<bool>() == true;
        var list = new List<DependencyRequest>();
        foreach (var entry in parameters["add"] as JsonArray ?? [])
        {
            if (entry is not JsonObject item) throw new ArgumentException("add: each entry is an object {producer?, producer_key?, elements[]}");
            var name = Text(item["producer"]); var key = Text(item["producer_key"]);
            if (name == null && key == null) throw new ArgumentException("add: each entry names its producer (producer or producer_key)");
            var elements = (item["elements"] as JsonArray ?? []).Select(e => Text(e)).Where(e => e != null).Select(e => e!).Distinct(StringComparer.Ordinal).ToList();
            if (elements.Count == 0 && !published) throw new ArgumentException("add: " + (name ?? key) + " names no element (elements[]); with published:true an empty list only aligns the reference");
            list.Add(new DependencyRequest(name, key, elements, published));
        }
        if (published)
        {
            foreach (var name in Strings(parameters["producers"]).Where(n => !list.Any(r => string.Equals(r.Producer, n, StringComparison.OrdinalIgnoreCase))))
                list.Add(new DependencyRequest(name, null, [], true));
            foreach (var key in Strings(parameters["producer_keys"]).Where(k => !list.Any(r => r.ProducerKey != null && SameKey(r.ProducerKey, k))))
                list.Add(new DependencyRequest(null, key, [], true));
        }
        return list;
    }

    /// <summary>Runs the Studio's Manage Dependencies on <paramref name="module"/> of <paramref name="aggregator"/> (the live
    /// tab, or a headless MockAggregatorPresenter) in one Studio command. <paramref name="service"/>: the catalog to load the
    /// signatures from; null is the Studio's own (ServerCommunicationsProvider.ReferencesService of the signed-in Studio).
    /// Answer: {committed, command, added[], alreadyReferenced[], references[{producer, key, kind, hashBefore, hashAfter,
    /// published, atPublished}], undo} or {committed:false, code, problems[] | error, stage}. Never throws for the request.</summary>
    public static JsonObject Apply(IAggregatorPresenter aggregator, ESpace module, IReadOnlyList<DependencyRequest> requests, IReferencesService? service = null,
        IApplicationInformationService? applicationInformation = null)
    {
        ArgumentNullException.ThrowIfNull(aggregator); ArgumentNullException.ThrowIfNull(module);
        var answer = new JsonObject { ["module"] = module.Name, ["moduleKey"] = module.Key.ToString(), ["command"] = CommandName };
        if (requests.Count == 0) { answer["committed"] = false; answer["problems"] = new JsonArray(); answer["reason"] = "nothing was requested"; return answer; }
        var added = new JsonArray(); var already = new JsonArray(); var references = new JsonArray();
        var problems = new List<JsonObject>();
        var hashesBefore = module.References.Where(r => r.ReferenceKey != null).ToDictionary(r => r.ReferenceKey.ToString(), r => r.ReferenceHash.ToString(), StringComparer.Ordinal);
        var failure = QuietCommand.Execute(aggregator.GetPresenterContext(), CommandName, stage =>
        {
            stage("initialize");
            using var manager = new ReferencesManager(aggregator, module, skipInitialization: true, CancellationToken.None, applicationInformation, service);
            if (manager.WasCancelled)
                throw new Refused([Problem("catalog-unavailable", null, null, null,
                    "The Studio could not read the referenceable producers of " + module.Name + " from its environment.",
                    "check that the Studio is signed in to the module's environment (o11_studio status), then deliver the same job again")]);
            manager.UncheckBehavior = UncheckBehavior.Uncheck;
            stage("resolve-producers");
            var catalog = manager.GetReferencesList().ToList();
            var keyed = new List<(DependencyRequest Request, ObjectKey Key, string Name)>();
            foreach (var request in requests)
            {
                ObjectKey? key = request.ProducerKey is { } given ? Keys.Parse(given) : null;
                key ??= module.References.FirstOrDefault(r => string.Equals(r.Name, request.Producer, StringComparison.OrdinalIgnoreCase))?.ReferenceKey;
                key ??= catalog.FirstOrDefault(i => string.Equals(i.Name, request.Producer, StringComparison.OrdinalIgnoreCase))?.Key;
                var label = request.Producer ?? catalog.FirstOrDefault(i => key != null && i.Key == key)?.Name ?? request.ProducerKey ?? "?";
                if (key == null)
                {
                    problems.Add(Problem("not-referenceable", label, request.ProducerKey, null, label + " is not a referenceable producer of the module's environment.",
                        "check that " + label + " is published and referenceable in this environment (o11_environment referenceable), then deliver the same job again"));
                    continue;
                }
                keyed.Add((request, key, label));
            }
            if (problems.Count > 0) throw new Refused(problems);
            stage("load-signatures");
            manager.InitializeAddReferences(CancellationToken.None, keyed.Select(k => k.Key).Distinct().ToArray());
            stage("resolve-elements");
            var plan = new List<(string Name, ObjectKey Key, Match Root, Reference Foreign, DependencyRequest Request, List<(string Spec, Match Element)> Elements)>();
            foreach (var (request, key, label) in keyed)
            {
                var foreign = manager.ReferencesESpace?.References.SingleOrDefault(r => r.ReferenceKey == key);
                var root = foreign?.Match;
                if (foreign == null || root == null || foreign.HasDeserializationErrors || ReferenceUtils.IsReferenceWithLoadErrors(root))
                {
                    problems.Add(Problem(foreign == null ? "not-referenceable" : "signature-unavailable", label, key.ToString(), null,
                        foreign == null ? "The Studio's catalog has no published signature of " + label + "."
                            : "The published signature of " + label + " could not be loaded by the Studio.",
                        foreign == null ? "check that " + label + " is published and referenceable in this environment (o11_environment referenceable), then deliver the same job again"
                            : "publish " + label + " again (its published signature does not load), then deliver the same job again"));
                    continue;
                }
                var name = foreign.Name;
                var elements = new List<(string Spec, Match Element)>();
                foreach (var spec in request.Elements)
                {
                    var matches = Candidates(root, spec).ToList();
                    if (matches.Count == 1) { elements.Add((spec, matches[0])); continue; }
                    problems.Add(matches.Count == 0
                        ? Problem("not-in-signature", name, key.ToString(), spec, ElementName(spec) + " is not in the published signature of " + name + ".",
                            "publish " + name + " with " + ElementName(spec) + " public, then deliver the same job again (o11_dependencies list shows what " + name + " publishes)")
                        : Problem("ambiguous", name, key.ToString(), spec, ElementName(spec) + " names " + matches.Count + " elements of " + name + ".",
                            "name it by its original key, Type:@<key> (o11_dependencies list shows the keys of " + name + "), then deliver again"));
                }
                plan.Add((name, key, root, foreign, request, elements));
            }
            if (problems.Count > 0) throw new Refused(problems);
            stage("check");
            // The identity of every element (native type, original key), read before the commit disposes the merge tree.
            var identities = new Dictionary<Match, (string Type, string? Key)>();
            foreach (var entry in plan)
            {
                // The Refresh of the producer first (the dialog's Refresh), then the checks of the elements to add.
                if (entry.Request.Published && entry.Root.MatchType == MatchType.InBothESpaces) manager.Refresh(entry.Root);
                foreach (var (spec, element) in entry.Elements)
                {
                    identities[element] = (element.AnyObject.GetType().FullName!, ModelHost.Prop(element.AnyObject, "OriginalKey")?.ToString());
                    var known = element.MatchType != MatchType.InForeignESpaceOnly;
                    if (!known || !ReferenceUtils.IsChecked(element)) manager.SetIsChecked(element, true);
                    var item = new JsonObject { ["producer"] = entry.Name, ["key"] = entry.Key.ToString(), ["element"] = element.AnyObject.Name, ["type"] = element.AnyObject.GetType().Name, ["spec"] = spec };
                    (known ? already : added).Add(item);
                }
            }
            // The Studio refuses some checks silently (an element not allowed in this module kind): read every check back.
            foreach (var entry in plan)
                foreach (var (spec, element) in entry.Elements)
                    if (!ReferenceUtils.IsChecked(element))
                        problems.Add(Problem("not-allowed", entry.Name, entry.Key.ToString(), spec, "The Studio does not let " + module.Name + " reference " + ElementName(spec) + " of " + entry.Name + " in this module kind.",
                            "use " + ElementName(spec) + " through a form this module may reference (for a server entity in a UI module, a service or server action of " + entry.Name + "), then deliver again"));
            if (problems.Count > 0) throw new Refused(problems);
            var published = plan.ToDictionary(p => p.Key.ToString(), p => p.Foreign.ReferenceHash.ToString(), StringComparer.Ordinal);
            var kinds = plan.ToDictionary(p => p.Key.ToString(), p => p.Foreign.ReferenceKind.ToString(), StringComparer.Ordinal);
            stage("commit");
            manager.CommitRefreshReferences(CommandName);
            stage("verify");
            foreach (var entry in plan)
            {
                var local = module.References.SingleOrDefault(r => r.ReferenceKey == entry.Key);
                var keyText = entry.Key.ToString();
                var lost = entry.Elements.Where(e => local == null || !Holds(local, identities[e.Element])).Select(e => e.Spec).ToList();
                if (lost.Count > 0)
                    problems.Add(Problem("not-retained", entry.Name, keyText, string.Join(", ", lost), "The Studio's Manage Dependencies did not keep " + string.Join(", ", lost.Select(ElementName)) + " of " + entry.Name + " in " + module.Name + ".",
                        "an SSAM defect (reported); nothing was applied (the command rolled back): deliver the same job again once the bridge is updated"));
                var after = local?.ReferenceHash.ToString();
                if (entry.Request.Published && local != null && !string.Equals(after, published[keyText], StringComparison.OrdinalIgnoreCase))
                    problems.Add(Problem("not-at-published", entry.Name, keyText, null, "The Studio kept " + entry.Name + " at " + after + "; its published signature is " + published[keyText] + ".",
                        "an SSAM defect (reported); nothing was applied (the command rolled back)"));
                references.Add(new JsonObject { ["producer"] = entry.Name, ["key"] = keyText, ["kind"] = kinds[keyText],
                    ["hashBefore"] = hashesBefore.TryGetValue(keyText, out var before) ? before : null, ["hashAfter"] = after,
                    ["published"] = published[keyText], ["atPublished"] = string.Equals(after, published[keyText], StringComparison.OrdinalIgnoreCase) });
            }
            if (problems.Count > 0) throw new Refused(problems);
        });
        if (failure != null)
        {
            answer["committed"] = false;
            if (failure.Error is Refused refused) { answer["code"] = Code; answer["problems"] = new JsonArray(refused.Problems.Select(p => (JsonNode)p).ToArray()); }
            else { answer["code"] = Code; answer["stage"] = failure.Stage; answer["error"] = failure.Error.GetType().Name + ": " + failure.Error.Message; }
            answer["reason"] = "nothing was applied: the Studio rolled the Manage Dependencies command back";
            return answer;
        }
        answer["committed"] = true;
        answer["changed"] = added.Count > 0 || references.OfType<JsonObject>().Any(r => !string.Equals(r["hashBefore"]?.ToString(), r["hashAfter"]?.ToString(), StringComparison.OrdinalIgnoreCase));
        answer["added"] = added; answer["alreadyReferenced"] = already; answer["references"] = references;
        answer["undo"] = "Ctrl+Z in the Studio undoes the Manage Dependencies; nothing was published";
        return answer;
    }

    /// <summary>The same Manage Dependencies headless: the OML at <paramref name="omlPath"/> loaded, the captured signatures
    /// (.avsig envelopes) served as the Studio's catalog, saved to <paramref name="outPath"/> only when it committed.</summary>
    public static JsonObject ApplyOffline(ModelHost host, string omlPath, IReadOnlyList<DependencyRequest> requests, IReadOnlyList<string> signaturePaths, string outPath)
    {
        ArgumentNullException.ThrowIfNull(host);
        var snapshots = signaturePaths.Select(NativeReferenceSnapshot.Read).ToList();
        var module = host.Load(omlPath);
        var settings = ServiceStudio.UserSettings.Settings.Instance;
        var cache = settings.DisableReferenceCache;
        try
        {
            // The Model API's own RefreshReferences does the same: the catalog is the one given, never a disk cache.
            settings.DisableReferenceCache = true;
            typeof(ESpace).GetMethod("PrepareForSave", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Public, Type.EmptyTypes)
                ?.Invoke(module, null);
            using var aggregator = new ServiceStudio.Presenter.Commands.MockAggregatorPresenter(module, null, registerAsStaticInstance: false);
            JsonObject answer;
            try { answer = Apply(aggregator, module, requests, new SnapshotCatalog(snapshots)); }
            finally { try { ServiceStudio.Undo.UndoManager.ClearHistory(aggregator); } catch { /* no history for this aggregator */ } }
            if (answer["committed"]?.GetValue<bool>() == true)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outPath))!);
                File.WriteAllBytes(outPath, host.Save(module));
                answer["path"] = Path.GetFullPath(outPath);
            }
            return answer;
        }
        finally { settings.DisableReferenceCache = cache; ModelHost.Release(module); }
    }

    /// <summary>The elements of a producer root a spec names: Type:Name | Type:@key | Name | @key (a Flow\Name path by its last segment).</summary>
    private static IEnumerable<Match> Candidates(Match root, string spec)
    {
        var colon = spec.IndexOf(':');
        var type = colon > 0 ? spec[..colon].Trim() : null;
        var tail = (colon > 0 ? spec[(colon + 1)..] : spec).Trim();
        var family = type == null ? null : NativeReferenceKinds.ForType(type);
        if (type != null && family == null) return [];
        var byKey = tail.StartsWith('@');
        var wanted = byKey ? Keys.Parse(tail[1..]).ToString() : tail.Contains('\\') ? tail[(tail.LastIndexOf('\\') + 1)..] : tail.Contains('/') ? tail[(tail.LastIndexOf('/') + 1)..] : tail;
        return root.GetAllChildren().Where(m => m.AnyObject is ITopLevelReferenceElement
            && (family == null || m.AnyObject.GetType().FullName == "ServiceStudio.Model." + family.Tag)
            && (byKey ? ModelHost.Prop(m.AnyObject, "OriginalKey")?.ToString() == wanted
                : string.Equals(m.AnyObject.Name, wanted, StringComparison.OrdinalIgnoreCase)
                  || string.Equals(ModelHost.Prop(m.AnyObject, "OriginalName")?.ToString(), wanted, StringComparison.OrdinalIgnoreCase)))
            .Distinct().ToList();
    }

    /// <summary>Whether the module's reference holds an element (same native type, same original key).</summary>
    private static bool Holds(Reference local, (string Type, string? Key) element)
    {
        return Descendants(local).Any(o => o.GetType().FullName == element.Type && ModelHost.Prop(o, "OriginalKey")?.ToString() == element.Key);
        static IEnumerable<AbstractObject> Descendants(AbstractObject parent)
        {
            foreach (var child in parent.DirectChildren) { yield return child; foreach (var nested in Descendants(child)) yield return nested; }
        }
    }

    private static string ElementName(string spec)
    {
        var colon = spec.IndexOf(':');
        return colon > 0 ? spec[(colon + 1)..] : spec;
    }

    private static JsonObject Problem(string cause, string? producer, string? key, string? element, string message, string fix) => new()
    {
        ["code"] = Code, ["severity"] = "error", ["cause"] = cause, ["producer"] = producer, ["key"] = key, ["element"] = element,
        ["message"] = message, ["fix"] = fix, ["patch"] = null,
    };

    private static string? Text(JsonNode? node) => node is JsonValue v && v.TryGetValue<string>(out var s) && !string.IsNullOrWhiteSpace(s) ? s.Trim() : null;
    private static IEnumerable<string> Strings(JsonNode? node) => (node as JsonArray ?? []).Select(n => Text(n)).Where(s => s != null).Select(s => s!);
    private static bool SameKey(string left, string right)
    {
        try { return Keys.Parse(left).Equals(Keys.Parse(right)); }
        catch (Exception ex) when (ex is FormatException or ArgumentException) { return string.Equals(left, right, StringComparison.Ordinal); }
    }

    /// <summary>The refusal raised inside the command: the command rolls back and the problems come back as the answer.</summary>
    private sealed class Refused(IReadOnlyList<JsonObject> problems) : InvalidOperationException("Manage Dependencies refused: " + string.Join("; ", problems.Select(p => p["message"]?.ToString())))
    {
        public IReadOnlyList<JsonObject> Problems { get; } = problems;
    }

    /// <summary>The Studio's catalog served from captured signatures (.avsig): each producer with its published signature,
    /// as the Model API's own RefreshReferences serves IModuleSignature (ServiceStudio.Presenter, ICommandServices).</summary>
    private sealed class SnapshotCatalog(IReadOnlyList<NativeReferenceSnapshot> snapshots) : IReferencesService
    {
        private readonly Dictionary<string, ReferenceInfo> _infos = snapshots.ToDictionary(s => Keys.Parse(s.ModuleKey).ToString(), Info, StringComparer.Ordinal);
        public IExtendedLoginInfo LoginInfo => new DefaultExtendedLoginInfo();
        public bool ListReferenceableMigratedToServerApi => false;
        public IEnumerable<ReferenceInfo> ListReferenceable(ObjectKey eSpaceKey, ObjectKey appKey, CancellationToken cancellationToken = default)
            => _infos.Values.Select(i => (ReferenceInfo)i.Clone()).ToList();
        public ReferenceInfo RefreshReferenceDetails(string referenceKey, string referenceKind, CancellationToken cancellationToken = default)
        {
            var key = Keys.Parse(referenceKey).ToString();
            if (_infos.TryGetValue(key, out var info)) { var copy = (ReferenceInfo)info.Clone(); copy.IsOperationStatusOk = true; return copy; }
            return new ReferenceInfo { Key = Keys.Parse(referenceKey), IsOperationStatusOk = false };
        }
        private static ReferenceInfo Info(NativeReferenceSnapshot s) => new()
        {
            Key = Keys.Parse(s.ModuleKey), Name = s.Name, Kind = s.ModuleKind.ToString(), Description = s.Description, SignatureHash = s.SignatureHash,
            SignatureBinary = s.SignatureBinary, Is_System = 0, JQueryVersion = s.JQueryVersion, Icon = s.Icon,
            RuntimeKind = (OutSystems.MetaModel.Enumerations.SegmentationKind)(int)s.ModuleType, ExtensibilityConfiguration = s.ExtensibilityConfigurations,
            AppKey = string.IsNullOrWhiteSpace(s.ApplicationKey) ? null! : Keys.Parse(s.ApplicationKey), IsOperationStatusOk = true,
        };
    }
}
