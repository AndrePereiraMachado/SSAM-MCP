using System.Diagnostics;
using System.Text.Json.Nodes;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
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

namespace Anvil.Bridge;

/// <summary>One producer of a Manage Dependencies request (the thin copy of Anvil.Core.DependencyRequest): the producer by
/// key (preferred) or by name, the elements to reference ("Type:Name", "Type:@originalKey", "Name" or "@originalKey") and
/// whether its reference is brought to the producer's published signature.</summary>
internal sealed record DependencyRequest(string? Producer, string? ProducerKey, IReadOnlyList<string> Elements, bool Published);

/// <summary>
/// servidor/fase4-26 a8 (the next agent pack): the Service Studio's own Manage Dependencies on an open module, without its
/// dialog, in the thin bridge the agent pack loads into the customer's Studio (capability refresh_references:add). The thin
/// copy of the kernel's Anvil.Core.ManageDependencies (product fix-ext-refs, 990a8e01: Requests and Apply), with Studio
/// types only: ReferencesManager.InitializeAddReferences loads the published signatures of the named producers from the
/// signed-in Studio's own catalog (an Extension's signature is its published extension reference, never an OML),
/// SetIsChecked checks each element, Refresh brings an existing reference to the published signature, and
/// CommitRefreshReferences merges it all, in one Studio command ("Manage Dependencies") opened by QuietCommand: Ctrl+Z undoes
/// it, nothing is published. All or nothing: every problem comes back at once with its fix and nothing is committed.
/// What the kernel keeps on the server: when a delivery runs it, with which elements (the job's reference ops), and what the
/// answer means for the delivery (Delivery, DeliveryManageDependencies). Not here: ApplyOffline and its captured catalog
/// (kernel tests and offline proofs). ManageDependenciesThinTests proves the same requests, families, answers and saved
/// models as the kernel's.
/// </summary>
internal static class ManageDependencies
{
    /// <summary>The Studio's own name of the command (ReferencesManager.AddRemoveReferencesCommandName).</summary>
    public const string CommandName = "Manage Dependencies";
    public const string Code = "REFERENCES_NOT_ADDED";
    /// <summary>The bridge capability (Anvil.Core Delivery.ManageDependenciesCapability).</summary>
    public const string Capability = "refresh_references:add";

    /// <summary>Whether refresh_references parameters ask for the Manage Dependencies (add, or published:true).</summary>
    public static bool Asks(JsonObject? parameters) => parameters?["add"] is JsonArray || parameters?["published"] is JsonValue v && v.TryGetValue<bool>(out var published) && published;

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

    /// <summary>Runs the Studio's Manage Dependencies on <paramref name="module"/> of <paramref name="aggregator"/> in one
    /// Studio command. <paramref name="service"/>: the catalog to load the signatures from; null is the Studio's own (the
    /// signed-in Studio's ReferencesService). Answer: {committed, command, added[], alreadyReferenced[], references[{producer,
    /// key, kind, hashBefore, hashAfter, published, atPublished}], undo} or {committed:false, code, problems[] | error, stage}.
    /// Never throws for the request.</summary>
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
                throw new Refused([Problem("catalog-unavailable", null, null, null)]);
            manager.UncheckBehavior = UncheckBehavior.Uncheck;
            stage("resolve-producers");
            var catalog = manager.GetReferencesList().ToList();
            var keyed = new List<(DependencyRequest Request, ObjectKey Key, string Name)>();
            foreach (var request in requests)
            {
                ObjectKey? key = request.ProducerKey is { } given ? BridgeKit.ParseKey(given) : null;
                key ??= module.References.FirstOrDefault(r => string.Equals(r.Name, request.Producer, StringComparison.OrdinalIgnoreCase))?.ReferenceKey;
                key ??= catalog.FirstOrDefault(i => string.Equals(i.Name, request.Producer, StringComparison.OrdinalIgnoreCase))?.Key;
                var label = request.Producer ?? catalog.FirstOrDefault(i => key != null && i.Key == key)?.Name ?? request.ProducerKey ?? "?";
                if (key == null)
                {
                    problems.Add(Problem("not-referenceable", label, request.ProducerKey, null, new JsonObject { ["where"] = "environment" }));
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
                        foreign == null ? new JsonObject { ["where"] = "catalog" } : null));
                    continue;
                }
                var name = foreign.Name;
                var elements = new List<(string Spec, Match Element)>();
                foreach (var spec in request.Elements)
                {
                    var matches = Candidates(root, spec).ToList();
                    if (matches.Count == 1) { elements.Add((spec, matches[0])); continue; }
                    problems.Add(matches.Count == 0
                        ? Problem("not-in-signature", name, key.ToString(), spec)
                        : Problem("ambiguous", name, key.ToString(), spec, new JsonObject { ["count"] = matches.Count }));
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
                    identities[element] = (element.AnyObject.GetType().FullName!, BridgeKit.InterfaceProp(element.AnyObject, "OriginalKey")?.ToString());
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
                        problems.Add(Problem("not-allowed", entry.Name, entry.Key.ToString(), spec));
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
                    problems.Add(Problem("not-retained", entry.Name, keyText, string.Join(", ", lost)));
                var after = local?.ReferenceHash.ToString();
                if (entry.Request.Published && local != null && !string.Equals(after, published[keyText], StringComparison.OrdinalIgnoreCase))
                    problems.Add(Problem("not-at-published", entry.Name, keyText, null, new JsonObject { ["after"] = after, ["published"] = published[keyText] }));
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

    /// <summary>The elements of a producer root a spec names: Type:Name | Type:@key | Name | @key (a Flow\Name path by its last segment).</summary>
    private static IEnumerable<Match> Candidates(Match root, string spec)
    {
        var colon = spec.IndexOf(':');
        var type = colon > 0 ? spec[..colon].Trim() : null;
        var tail = (colon > 0 ? spec[(colon + 1)..] : spec).Trim();
        var tag = type == null ? null : FamilyTag(type);
        if (type != null && tag == null) return [];
        var byKey = tail.StartsWith('@');
        var wanted = byKey ? BridgeKit.ParseKey(tail[1..]).ToString() : tail.Contains('\\') ? tail[(tail.LastIndexOf('\\') + 1)..] : tail.Contains('/') ? tail[(tail.LastIndexOf('/') + 1)..] : tail;
        return root.GetAllChildren().Where(m => m.AnyObject is ITopLevelReferenceElement
            && (tag == null || m.AnyObject.GetType().FullName == "ServiceStudio.Model." + tag)
            && (byKey ? BridgeKit.InterfaceProp(m.AnyObject, "OriginalKey")?.ToString() == wanted
                : string.Equals(m.AnyObject.Name, wanted, StringComparison.OrdinalIgnoreCase)
                  || string.Equals(BridgeKit.InterfaceProp(m.AnyObject, "OriginalName")?.ToString(), wanted, StringComparison.OrdinalIgnoreCase)))
            .Distinct().ToList();
    }

    /// <summary>The native tag of the public reference family a spec's type names (the Model API interface or one of its
    /// aliases; a type written without its "I" is the family of the interface with it), or null: the thin copy of the kernel's
    /// NativeReferenceKinds.ForType, proved equal by ManageDependenciesThinTests.TheElementFamiliesAreTheKernels.</summary>
    internal static string? FamilyTag(string type) => Exact(type)
        ?? (type.Length > 0 && char.IsUpper(type[0]) && !(type.Length > 1 && type[0] == 'I' && char.IsUpper(type[1])) ? Exact("I" + type) : null);
    private static string? Exact(string type) => Families.SingleOrDefault(f => f.Names.Contains(type, StringComparer.Ordinal)).Tag;
    private static readonly (string Tag, string[] Names)[] Families =
    [
        ("ReferenceAction", ["IServerActionSignature", "IServerAction"]),
        ("ReferenceEntity", ["IEntitySignature", "IServerEntity", "IServerEntitySignature", "IStaticEntity", "IStaticEntitySignature", "IClientEntity", "IClientEntitySignature"]),
        ("ReferenceStructure", ["IStructureSignature", "IStructure"]),
        ("ReferenceServiceAPIMethod", ["IServiceActionSignature", "IServiceAction"]),
        ("ReferenceClientAction", ["IClientActionSignature", "IClientAction"]),
        ("ReferenceRole", ["IRoleSignature", "IRole"]),
        ("ReferenceImage", ["IImageSignature", "IImage"]),
        ("ReferenceResource", ["IResourceSignature", "IResource"]),
        ("ReferenceScript", ["IScriptSignature", "IScript"]),
        ("ReferenceProcess", ["IProcessSignature", "IProcess"]),
        ("ReferenceTheme", ["IWebThemeSignature", "IWebTheme"]),
        ("NewRuntime.ReferenceTheme", ["IMobileThemeSignature", "IMobileTheme"]),
        ("ReferenceWebFlow", ["IWebFlowSignature", "IWebFlow"]),
        ("NewRuntime.ReferenceWebFlow", ["IMobileFlowSignature", "IMobileFlow"]),
        ("ReferenceWebBlock", ["IWebBlockSignature", "IWebBlock"]),
        ("NewRuntime.ReferenceWebBlock", ["IMobileBlockSignature", "IBlockSignature", "IBlock", "IMobileBlock"]),
        ("ReferenceWebScreen", ["IWebScreenSignature", "IWebScreen"]),
        ("NewRuntime.ReferenceWebScreen", ["IMobileScreenSignature", "IScreenSignature", "IScreen", "IMobileScreen"]),
    ];

    /// <summary>Whether the module's reference holds an element (same native type, same original key).</summary>
    private static bool Holds(Reference local, (string Type, string? Key) element)
    {
        return Descendants(local).Any(o => o.GetType().FullName == element.Type && BridgeKit.InterfaceProp(o, "OriginalKey")?.ToString() == element.Key);
        static IEnumerable<AbstractObject> Descendants(AbstractObject parent)
        {
            foreach (var child in parent.DirectChildren) { yield return child; foreach (var nested in Descendants(child)) yield return nested; }
        }
    }

    /// <summary>The neutral fix of every problem this bridge answers: the server writes the real one.</summary>
    internal const string NeutralFix = "fix the cause, then repeat";

    /// <summary>a8 round 2 (review, IP option D): a problem as the bridge answers it: the cause and the facts the Studio showed
    /// (producer, key, element; facts: where, count, after, published, kind), a neutral message ("cause: subject") and the
    /// neutral fix. The explanation and the fix are written on the server from the cause (Anvil.Core ManageDependenciesText
    /// in the kernel, manage-dependencies-text.mjs in the facade), so no product text of the Manage Dependencies is compiled
    /// into the agent pack. A server that predates them shows the neutral texts, the causes and the facts.</summary>
    internal static JsonObject Problem(string cause, string? producer, string? key, string? element, JsonObject? facts = null)
    {
        var subject = element != null ? element + (producer != null ? " of " + producer : "") : producer ?? key;
        var problem = new JsonObject { ["code"] = Code, ["severity"] = "error", ["cause"] = cause, ["producer"] = producer, ["key"] = key, ["element"] = element,
            ["message"] = cause + (subject != null ? ": " + subject : ""), ["fix"] = NeutralFix, ["patch"] = null };
        if (facts != null) problem["facts"] = facts;
        return problem;
    }

    private static string? Text(JsonNode? node) => node is JsonValue v && v.TryGetValue<string>(out var s) && !string.IsNullOrWhiteSpace(s) ? s.Trim() : null;
    private static IEnumerable<string> Strings(JsonNode? node) => (node as JsonArray ?? []).Select(n => Text(n)).Where(s => s != null).Select(s => s!);
    private static bool SameKey(string left, string right)
    {
        try { return BridgeKit.ParseKey(left).Equals(BridgeKit.ParseKey(right)); }
        catch (Exception ex) when (ex is FormatException or ArgumentException) { return string.Equals(left, right, StringComparison.Ordinal); }
    }

    /// <summary>The refusal raised inside the command: the command rolls back and the problems come back as the answer.</summary>
    private sealed class Refused(IReadOnlyList<JsonObject> problems) : InvalidOperationException("Manage Dependencies refused: " + string.Join("; ", problems.Select(p => p["message"]?.ToString())))
    {
        public IReadOnlyList<JsonObject> Problems { get; } = problems;
    }
}

/// <summary>
/// servidor/fase4-26 a8: refresh_references with add or published:true in the thin bridge (the agent pack): the Studio's own
/// Manage Dependencies (ManageDependencies.Apply) on the module of module_key, on its aggregator queue when the top level is
/// idle, as the full bridge's RefreshReferencesHandler.Manage of the product. Refusals before anything ran come with
/// executed:false: a bad request, no target, a dialog or merge editor pending (the same text as the Refresh References, which
/// the server's facade answers by closing the dependencies dialog first, MB2); a dialog open before the command is the
/// person's and refuses it. a8 round 3 (re-review C:\t\revisoes\agent-pack-next-2\REVISAO.md, N1): a window that opens
/// DURING the command is decided by the product's rule (family D, OperationDialogPolicy.Decide), never more: the bridge
/// closes only what that rule closes for certain (the Studio's error report "Unexpected Error", the dependencies dialog by
/// its page text through DependenciesDialog, an OK-only native box), as the window's X does, and the answer is what the
/// command did with those windows first (committed false: one refusal whose first problem is studio-dialog; committed true
/// keeps its commit; dialogs lists them). Any other window (a sign-in, a recovery Open | Discard, a question, an editor with
/// typed text, another tab's Manage Dependencies, a modal presenter) may be the person's: it is never closed. The command
/// gets Grace to end by itself (an unrelated window of another tab), and its answer then names the window in dialogs (closed
/// false); otherwise the bridge stops waiting and answers blocked (outcome running, the window), which the server answers
/// STUDIO_DIALOG_PENDING with its title, never ok: the command may be waiting for that window in the Studio. A command that
/// did not end within the timeout is unknown.
/// Answer: Apply's {committed, command, added[], alreadyReferenced[], references[], undo | code, problems[] | error, stage}
/// plus {refreshed, upToDate, newErrors, elapsedMs, dependenciesDialog, dialogs, dialogsBefore}.
/// </summary>
internal static class ManageDependenciesHandler
{
    private static readonly TimeSpan Poll = TimeSpan.FromMilliseconds(1500);
    /// <summary>How many certain windows the bridge closes during one command; past it, a window is left as a question.</summary>
    internal const int MaxClosed = 3;
    /// <summary>How long a window the bridge must not close may stay open before the answer is pending (the command may still
    /// end by itself: the window may be another tab's).</summary>
    internal const long GraceMs = 3000;

    /// <summary>The step of the bridge at one read of the dialogs: wait, close a certain window, or answer pending.</summary>
    internal enum Step { Wait, Close, Pending }

    public static async Task<string> Handle(JsonObject? p)
    {
        var timeout = Math.Clamp(p?["timeout"]?.GetValue<int>() ?? 600, 10, 1800);
        var sw = Stopwatch.StartNew();
        IReadOnlyList<DependencyRequest> requests;
        try { requests = ManageDependencies.Requests(p ?? new JsonObject()); }
        catch (ArgumentException ex) { return Server.NotExecuted("refresh_references: " + ex.Message); }
        catch (InvalidOperationException ex) { return Server.NotExecuted("refresh_references: " + ex.Message); }
        if (requests.Count == 0) return Server.NotExecuted("refresh_references: add names no producer and published names none (producers or producer_keys)");
        // MB2 (answer_dependencies:true): the dependencies dialog is answered (Cancel) first, as for the Refresh References.
        var answered = p?["answer_dependencies"]?.GetValue<bool>() == true ? (await DependenciesDialog.Answer()).Answered : new JsonArray();
        var dependencies = answered.Count > 0 ? new JsonObject { ["answered"] = answered } : null;
        IAggregatorPresenter aggregator; ESpace module; Dictionary<string, Guid> before; int errorsBefore; JsonArray blockingBefore;
        try
        {
            (aggregator, module, before, errorsBefore, blockingBefore) = await Ui.Run(() =>
            {
                var (a, e) = Studio.Target(p);
                Studio.RequireTarget(a, e, p);
                var pending = Dialogs.BlockedBy(a);
                if (pending.Count > 0 || e.Match != null)
                    throw new InvalidOperationException($"refresh_references: '{e.Name}' has a dialog or merge editor pending in the Studio"
                        + (pending.Count > 0 ? $" ({Dialogs.Summary(pending)})" : "") + "; nothing was refreshed");
                return (a, e, Hashes(e), Reads.ErrorCount(e), Dialogs.BlockedBy(null));
            }, UiGate.Model, "refresh_references: read the module");
        }
        catch (Exception ex) { return Server.NotExecuted(Server.Unwrap(ex)); }

        var done = new TaskCompletionSource<JsonObject>(TaskCreationOptions.RunContinuationsAsynchronously);
        var queued = aggregator.ExecuteInContext(() =>
        {
            try { done.TrySetResult(ManageDependencies.Apply(aggregator, module, requests)); }
            catch (Exception ex) { done.TrySetException(ex); }
        }, executeWhenTopLevelIsIdle: true);
        _ = queued.ContinueWith(t => done.TrySetException(t.Exception?.InnerException ?? new InvalidOperationException("the Manage Dependencies was not run")),
            TaskContinuationOptions.OnlyOnFaulted);
        UiGate.MarkDispatched();
        var deadline = sw.Elapsed + TimeSpan.FromSeconds(timeout);
        var closed = new JsonArray();
        var tried = new HashSet<string>(StringComparer.Ordinal); var webChecked = new HashSet<string>(StringComparer.Ordinal);
        long? questionSince = null; JsonObject? question = null;
        while (!done.Task.IsCompleted)
        {
            var left = deadline - sw.Elapsed;
            if (left <= TimeSpan.Zero)
                return Server.Fail($"refresh_references: the Manage Dependencies of '{module.Name}' did not end within {timeout} s; its outcome is unknown. Check the module in the Studio (Ctrl+Z undoes it)."
                    + (closed.Count > 0 ? " The bridge closed during it: " + string.Join("; ", closed.Select(d => d!["title"]?.ToString())) : ""));
            if (await Task.WhenAny(done.Task, Task.Delay(left < Poll ? left : Poll)) == done.Task) break;
            JsonArray now;
            try { now = await Ui.Run(() => Dialogs.BlockedBy(aggregator), TimeSpan.FromSeconds(8), "refresh_references: the dialogs of the Manage Dependencies"); }
            catch (UiBusyException) { UiGate.Forget(); continue; }
            catch (Exception ex) when (ex is not OutOfMemoryException) { Server.Log("manage dependencies dialog read: " + Server.Unwrap(ex)); continue; }
            // The dependencies dialog is certain by its page text (MB2): a web window not read yet is asked about once.
            var fresh = Fresh(blockingBefore, now);
            if (fresh.Any(d => d["contentKind"]?.ToString() == "web" && webChecked.Add(IdOf(d))))
            {
                var (dependencyDialogs, _) = await DependenciesDialog.Answer();
                foreach (var entry in dependencyDialogs.OfType<JsonObject>())
                    closed.Add(new JsonObject { ["kind"] = entry["kind"]?.DeepClone(), ["title"] = entry["title"]?.DeepClone(), ["type"] = "DialogWindow", ["source"] = "window",
                        ["answer"] = "Cancel", ["closed"] = true });
                if (dependencyDialogs.Count > 0) continue;
            }
            var (step, dialog) = Next(blockingBefore, now, closed.Count, tried, questionSince, sw.ElapsedMilliseconds);
            switch (step)
            {
                case Step.Close:
                    tried.Add(IdOf(dialog!));
                    if (await Close(dialog!)) closed.Add(Closed(dialog!));
                    continue;
                case Step.Pending:
                    return Server.Ok(Blocked(module, dialog!, closed, dependencies, sw.ElapsedMilliseconds));
                default:
                    if (dialog == null) { questionSince = null; question = null; }
                    else { questionSince ??= sw.ElapsedMilliseconds; question = dialog; }
                    continue;
            }
        }
        JsonObject answer;
        try { answer = await done.Task; }
        catch (Exception ex)
        {
            return Server.Fail("refresh_references: Manage Dependencies: " + Server.Unwrap(ex) + "; check the module in the Studio before any retry"
                + (closed.Count > 0 ? ". The bridge closed during it: " + string.Join("; ", closed.Select(d => d!["title"]?.ToString())) : ""));
        }
        // A window the bridge left open while the command ended by itself is named (closed false), no problem of the answer.
        if (question != null) closed.Add(Seen(question));
        answer = WithClosedDialogs(answer, closed);
        return await Reads.OnUi(() =>
        {
            var refreshed = new JsonArray(); var upToDate = new JsonArray();
            foreach (var reference in module.References)
            {
                var named = requests.Any(r => string.Equals(r.Producer, reference.Name, StringComparison.OrdinalIgnoreCase)
                    || r.ProducerKey != null && reference.ReferenceKey != null && BridgeKit.ParseKey(r.ProducerKey).Equals(reference.ReferenceKey));
                if (!named) continue;
                if (!before.TryGetValue(reference.Name, out var old) || old != reference.ReferenceHash) refreshed.Add(reference.Name); else upToDate.Add(reference.Name);
            }
            answer["refreshed"] = refreshed; answer["upToDate"] = upToDate;
            answer["newErrors"] = Math.Max(0, Reads.ErrorCount(module) - errorsBefore);
            answer["elapsedMs"] = sw.ElapsedMilliseconds;
            answer["dependenciesDialog"] = dependencies?.DeepClone();
            answer["dialogs"] ??= null;
            answer["dialogsBefore"] = null;
            return Server.Ok(answer);
        }, UiGate.Model, "refresh_references: read the Manage Dependencies result");
    }

    private static readonly string[] ErrorTitles = ["Unexpected Error", "Unexpected error", "Erro inesperado"];
    private static readonly string[] SignInWords = ["sign in", "sign-in", "log in", "login", "password", "username", "single sign-on"];
    private static readonly string[] ConsentWords = ["accept", "agree", "terms", "consent", "license agreement"];
    private static readonly string[] Dismissive = ["OK", "Ok", "Close", "Fechar"];

    /// <summary>What the product's rule (family D, OperationDialogPolicy.Decide) closes for certain, of a window that opened
    /// during the command: "UnexpectedError" (the Studio's error report, by its title or its text: it asks nothing, the Studio
    /// already rolled back the command that raised it) or "MessageBox" (a native box whose only buttons are OK or Close); null
    /// for anything else, which is never closed: a modal presenter, a recovery Open | Discard, a sign-in, a consent, a web page
    /// (the dependencies dialog is decided by its page text, DependenciesDialog), a question with choices. Pure.</summary>
    internal static string? Certain(JsonObject dialog)
    {
        if (dialog["source"]?.ToString() != "window") return null;
        var title = (dialog["title"]?.ToString() ?? "").Trim();
        var texts = (dialog["texts"] as JsonArray ?? []).Select(t => t?.ToString() ?? "").ToList();
        var buttons = texts.Where(t => t.StartsWith("[Button] ", StringComparison.Ordinal)).Select(t => t[9..].Trim())
            .Where(b => b.Length > 0 && b != "Viewbox").Distinct(StringComparer.Ordinal).ToList();
        var all = title + " " + string.Join(" ", texts.Where(t => !t.StartsWith("[Button]", StringComparison.Ordinal)));
        if (ErrorTitles.Any(t => title.Equals(t, StringComparison.OrdinalIgnoreCase)) || IsErrorReport(all)) return "UnexpectedError";
        if (all.Contains("Discard", StringComparison.OrdinalIgnoreCase) && all.Contains("Open", StringComparison.OrdinalIgnoreCase)) return null;
        if (buttons.Contains("Discard", StringComparer.OrdinalIgnoreCase)) return null;
        if (SignInWords.Any(w => all.Contains(w, StringComparison.OrdinalIgnoreCase)) || ConsentWords.Any(w => all.Contains(w, StringComparison.OrdinalIgnoreCase))) return null;
        if (dialog["contentKind"]?.ToString() == "web") return null;
        return buttons.Count > 0 && buttons.All(b => Dismissive.Contains(b, StringComparer.OrdinalIgnoreCase)) ? "MessageBox" : null;
    }

    private static bool IsErrorReport(string all) => all.Contains("unexpected error", StringComparison.OrdinalIgnoreCase)
        || all.Contains("exception", StringComparison.OrdinalIgnoreCase) && (all.Contains("report", StringComparison.OrdinalIgnoreCase) || all.Contains("stack trace", StringComparison.OrdinalIgnoreCase));

    /// <summary>The step at one read of the dialogs: the first certain window not tried yet is closed (at most MaxClosed per
    /// command); any other new window is left as it is, and after GraceMs open the answer is pending with it. The window of
    /// a Wait is the one left open (null when none). Pure.</summary>
    internal static (Step Step, JsonObject? Dialog) Next(JsonArray before, JsonArray now, int closedCount, IReadOnlySet<string> tried, long? questionSinceMs, long nowMs)
    {
        var fresh = Fresh(before, now);
        var certain = fresh.FirstOrDefault(d => Certain(d) != null && !tried.Contains(IdOf(d)));
        if (certain != null && closedCount < MaxClosed) return (Step.Close, certain);
        var left = fresh.FirstOrDefault();
        if (left == null) return (Step.Wait, null);
        return questionSinceMs is { } since && nowMs - since >= GraceMs ? (Step.Pending, left) : (Step.Wait, left);
    }

    /// <summary>The blocking dialogs of <paramref name="now"/> that were not open before the command. Pure.</summary>
    internal static List<JsonObject> Fresh(JsonArray before, JsonArray now)
    {
        var seen = new HashSet<string>(before.Select(IdOf), StringComparer.Ordinal);
        return now.OfType<JsonObject>().Where(d => !seen.Contains(IdOf(d))).ToList();
    }

    /// <summary>The entry of a window the bridge left open while the command ended by itself (dialogs of the answer). Pure.</summary>
    internal static JsonObject Seen(JsonObject dialog) => new() { ["kind"] = dialog["kind"]?.DeepClone(), ["title"] = dialog["title"]?.DeepClone(),
        ["type"] = dialog["type"]?.DeepClone(), ["source"] = dialog["source"]?.DeepClone(), ["answer"] = null, ["closed"] = false };

    /// <summary>The entry of a window the bridge closed (dialogs of the answer, refreshDialogs of the delivery). Pure.</summary>
    internal static JsonObject Closed(JsonObject dialog) => new() { ["kind"] = dialog["kind"]?.DeepClone(), ["title"] = dialog["title"]?.DeepClone(),
        ["type"] = dialog["type"]?.DeepClone(), ["source"] = "window", ["answer"] = "close", ["closed"] = true };

    /// <summary>The answer of a command a dialog holds that the bridge could not close: it waits in the Studio. Pure.</summary>
    internal static JsonObject Blocked(ESpace? module, JsonObject dialog, JsonArray closed, JsonObject? dependencies, long elapsedMs) => new()
    {
        ["module"] = module?.Name, ["moduleKey"] = module?.Key.ToString(), ["command"] = ManageDependencies.CommandName, ["changed"] = null,
        ["blocked"] = true, ["outcome"] = "running", ["blockedBy"] = dialog.DeepClone(), ["dialogs"] = closed.DeepClone(), ["elapsedMs"] = elapsedMs,
        ["dialogsBefore"] = null, ["dependenciesDialog"] = dependencies?.DeepClone(),
        ["next"] = "the person answers the dialog in the Studio; the Manage Dependencies then ends by itself (Ctrl+Z undoes it)",
    };

    /// <summary>What the command did, with the windows the bridge closed during it: committed true keeps its commit (and
    /// dialogs); committed false is one refusal whose first problems are the closed dialogs (studio-dialog, the window's
    /// title), then the Studio's own problems, so the server refuses it typed (REFERENCES_NOT_ADDED) and never retries blind.
    /// Pure.</summary>
    internal static JsonObject WithClosedDialogs(JsonObject answer, JsonArray closed)
    {
        if (closed.Count == 0) return answer;
        answer["dialogs"] = closed.DeepClone();
        if (answer["committed"]?.GetValue<bool>() == true) return answer;
        var shut = closed.OfType<JsonObject>().Where(d => d["closed"]?.GetValue<bool>() == true).ToList();
        if (shut.Count == 0) return answer;
        var problems = new JsonArray(shut.Select(d => (JsonNode)ManageDependencies.Problem("studio-dialog", null, null,
            d["title"]?.ToString() is { Length: > 0 } title ? title : d["type"]?.ToString(), new JsonObject { ["kind"] = d["kind"]?.DeepClone() })).ToArray());
        foreach (var problem in answer["problems"] as JsonArray ?? []) problems.Add(problem!.DeepClone());
        answer["committed"] = false; answer["code"] = ManageDependencies.Code; answer["problems"] = problems;
        return answer;
    }

    /// <summary>Closes the visible windows of this dialog (same type and title, an owner or a DialogWindow), as the window's X,
    /// then reads the dialogs again: true when it is gone. UI thread, bounded.</summary>
    private static async Task<bool> Close(JsonObject dialog)
    {
        var type = dialog["type"]?.ToString(); var title = dialog["title"]?.ToString();
        try
        {
            var count = await Ui.Run(() =>
            {
                var lifetime = Application.Current?.ApplicationLifetime as IClassicDesktopStyleApplicationLifetime;
                var targets = (lifetime?.Windows ?? new List<Window>()).Where(w => w.IsVisible && (w.Owner != null || w.GetType().Name.Contains("DialogWindow", StringComparison.Ordinal))
                    && string.Equals(w.GetType().Name, type, StringComparison.Ordinal) && string.Equals(w.Title, title, StringComparison.Ordinal)).ToList();
                foreach (var w in targets) w.Close();
                return targets.Count;
            }, TimeSpan.FromSeconds(8), "refresh_references: close the dialog of the Manage Dependencies");
            if (count == 0) return false;
            await Task.Delay(Poll);
            var after = await Ui.Run(() => Dialogs.BlockedBy(null), TimeSpan.FromSeconds(8), "refresh_references: the dialogs after the close");
            return !after.OfType<JsonObject>().Any(d => SameDialog(d, dialog));
        }
        catch (UiBusyException) { UiGate.Forget(); return false; }
        catch (Exception ex) when (ex is not OutOfMemoryException) { Server.Log("manage dependencies dialog close: " + Server.Unwrap(ex)); return false; }
    }

    private static bool SameDialog(JsonObject a, JsonObject b) => IdOf(a) == IdOf(b);
    /// <summary>The identity of a dialog read (kind, type, title, source).</summary>
    internal static string IdOf(JsonNode? d) => d?["kind"] + "|" + d?["type"] + "|" + d?["title"] + "|" + d?["source"];

    /// <summary>The first blocking dialog of <paramref name="now"/> that was not open before the command (the same kind, type,
    /// title and source), or null. Pure.</summary>
    internal static JsonObject? NewBlocking(JsonArray before, JsonArray now) => Fresh(before, now).FirstOrDefault();

    private static Dictionary<string, Guid> Hashes(ESpace module)
    {
        var result = new Dictionary<string, Guid>(StringComparer.Ordinal);
        foreach (var reference in module.References) result[reference.Name] = reference.ReferenceHash;
        return result;
    }
}
