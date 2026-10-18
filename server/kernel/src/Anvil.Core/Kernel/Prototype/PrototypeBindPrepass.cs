using System.Text.Json.Nodes;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// data.bind before the apply (docs/PROTOTIPO-NATIVO.md 2.12), in the job runner, outside any edit transaction: for each prototype
/// op with a binding it reads the producer's surface, checks the binding and, when something is still unbound (or the binding
/// names only its producer), refuses ONCE with PROTOTYPE_BINDING_REQUIRED: every list, text and event that needs a binding, each
/// with the proposal of PrototypeBindDiscovery. Every proposal is re-validated before it is offered: the op is planned and built
/// with the whole proposal on a fresh copy of the base, with the producer referenced as the delivery will, and Verified; a proposal
/// the build or the Verify refuses is dropped (unresolved, with the failure) and the rest is built once more. Nothing of this reaches
/// the module. A complete binding goes on: its frozen producer signature (.avsig) is returned to be imported before the transaction.
/// </summary>
internal static class PrototypeBindPrepass
{
    public static List<JsonObject> Run(ModelHost host, byte[] baseBytes, JsonArray ops, string? opsPointer, Func<string, ServiceStudio.Model.ESpace> loadProducer, Action<string>? log)
    {
        var references = new List<JsonObject>();
        var problems = new JsonArray();
        var messages = new List<string>();
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "prototype" || op["data"] is not JsonObject data || data["bind"] is not JsonObject bind) continue;
            if (data["_validate"]?.GetValue<bool>() == true || PrototypeBind.Shape(data).Count > 0) continue;
            var loadProblems = new List<PrototypeCapture.Problem>();
            var capture = PrototypeCapture.Load(data, loadProblems);
            if (capture == null || loadProblems.Count > 0 || data["_producer"]?.ToString() is not { } file) continue; // the op refuses with them
            PrototypeProducer producer;
            try { producer = Surface(host, baseBytes, file, bind["producer"]!.ToString(), loadProducer, log); }
            catch (InvalidOperationException ex) when (ex.Message.Contains(JobRunner.OutdatedReference, StringComparison.Ordinal))
            {
                // fix/system-reference round 4 (M3-R): the module references the producer at another signature than its capture.
                // Met here (the surface read imports the capture into a scratch copy of the base), it is the same coded refusal a
                // reference op gets (JobRunner.ReferenceProblems): REFERENCE_OUTDATED at this op, with its one continuation.
                var reference = new JsonObject { ["producer"] = bind["producer"]!.ToString(), ["elements"] = new JsonArray() };
                throw new KernelRefusalException("REFERENCE_OUTDATED", ex.Message, JobRunner.ReferenceProblems(ex, reference, i, opsPointer ?? "/ops"));
            }
            var applied = PrototypeBind.Apply(capture, bind, producer, file);
            if (applied.Problems.Count > 0) continue; // names the producer or the capture lack: the op refuses with the closest ones
            if (applied.Unbound.Count == 0 && PrototypeBind.HasBindings(bind))
            {
                if (file.EndsWith(".avsig", StringComparison.OrdinalIgnoreCase))
                    references.Add(new JsonObject { ["op"] = "reference", ["producer"] = file, ["elements"] = new JsonArray(PrototypeBind.ElementsOf(bind).Select(e => (JsonNode)e).ToArray()), ["_prototype"] = i });
                continue;
            }
            var proposal = PrototypeBindDiscovery.Propose(capture, bind, producer, applied);
            var started = System.Diagnostics.Stopwatch.StartNew();
            var validation = Validate(host, baseBytes, data, proposal, file, loadProducer, log);
            log?.Invoke($"prototype bind: {proposal.Items.Count} item(s), {proposal.Items.Count(x => x.Validated)} validated offline in {started.ElapsedMilliseconds} ms");
            var at = $"{opsPointer ?? "/ops"}/{i}/data";
            foreach (var item in proposal.Items.OrderBy(x => x.Unresolved).ThenBy(x => Order(x.Section)))
            {
                var pointer = $"{at}/bind/{item.Section}/{PrototypeBind.Esc(item.Key)}";
                var offered = item.Value != null && item.Validated && !item.Unresolved;
                var what = item.Kind switch { "source" => $"the {(item.Section == "screens" ? "view" : "popup")} {item.Key}", "list" => $"the list {item.Key}", "slot" => $"the text {item.Key}" + (item.Text != null ? $" (\"{item.Text}\")" : ""), _ => $"the event {item.Key}" };
                var message = offered
                    ? $"prototype: {what} binds to {producer.Name}: {item.Why}"
                    : $"prototype: {what} has no binding to {producer.Name} that builds: {item.Failure ?? item.Why}";
                var fix = offered
                    ? "apply the patch (it was planned and built offline against the producer before it was offered)"
                    : $"write bind.{item.Section}[\"{item.Key}\"] yourself (an expression over the data actions), or null to keep the prototype's own value";
                var patch = offered ? new JsonArray(new JsonObject { ["op"] = "add", ["path"] = pointer, ["value"] = item.Value!.DeepClone() }) : null;
                var problem = JobPreflight.Problem(i, pointer, PrototypeBind.Required, "error", message, fix, patch, "prototype");
                problem["binding"] = new JsonObject { ["kind"] = item.Kind, ["key"] = item.Key, ["owner"] = item.Owner, ["required"] = item.Required, ["validated"] = offered, ["unresolved"] = !offered };
                if (!offered && item.Value != null) problem["binding"]!["candidate"] = item.Value.DeepClone();
                problems.Add(JobPreflight.PublicProblem(problem));
            }
            messages.Add($"op #{i}: {proposal.Items.Count(x => x.Validated && !x.Unresolved)} binding(s) proposed and built offline, {proposal.Items.Count(x => !x.Validated || x.Unresolved)} unresolved"
                + (validation != null ? $" ({validation})" : ""));
        }
        if (problems.Count > 0)
            throw new KernelRefusalException(PrototypeBind.Required, "prototype: data.bind needs bindings to the producer, all proposed at once: " + string.Join(" | ", messages), problems);
        return references;
    }

    private static int Order(string section) => section switch { "screens" => 0, "modals" => 1, "lists" => 2, "slots" => 3, _ => 4 };

    /// <summary>The producer's public surface: its own model (an .oml), or the signature (.avsig) imported into a scratch copy of the
    /// base, never into the module the job edits.</summary>
    internal static PrototypeProducer Surface(ModelHost host, byte[] baseBytes, string file, string name, Func<string, ServiceStudio.Model.ESpace> loadProducer, Action<string>? log)
    {
        if (!file.EndsWith(".avsig", StringComparison.OrdinalIgnoreCase))
        {
            var espace = loadProducer(file);
            return PrototypeProducer.Read(TypeResolver.Name(espace) ?? name, ((IObjectSignature)espace).Children.Cast<object>(), publicOnly: true);
        }
        var snapshot = NativeReferenceSnapshot.Read(file);
        var scratch = host.Load(baseBytes);
        try
        {
            var session = new ModelSession(scratch);
            var all = new JsonArray(snapshot.Elements.Select(e => (JsonNode)(NativeReferenceSnapshot.InterfaceOf(e.Kind) + ":" + e.Name)).ToArray());
            session.PrepareSignatureReference(new JsonObject { ["op"] = "reference", ["producer"] = file, ["elements"] = all }, snapshot);
            var reference = scratch.References.FirstOrDefault(r => string.Equals(r.Name, snapshot.Name, StringComparison.OrdinalIgnoreCase));
            return PrototypeProducer.Read(snapshot.Name, reference == null ? [] : ((IObjectSignature)reference).Children.Cast<object>(), publicOnly: false);
        }
        finally { ModelHost.Release(scratch); }
    }

    /// <summary>The offline build of the proposal: the op with the proposed binding (what has no proposal kept as the prototype's own
    /// value) planned and applied on a fresh copy of the base, then Verified. Failing items are dropped and the rest built once more.
    /// Returns a note when the build itself failed without naming an item.</summary>
    private static string? Validate(ModelHost host, byte[] baseBytes, JsonObject data, PrototypeBindDiscovery.Proposal proposal, string file, Func<string, ServiceStudio.Model.ESpace> loadProducer, Action<string>? log)
    {
        string? note = null;
        for (var attempt = 0; attempt < 3; attempt++)
        {
            var candidate = Candidate(proposal);
            var outcome = Build(host, baseBytes, data, candidate, file, loadProducer);
            if (outcome.Failures.Count == 0)
            {
                foreach (var item in proposal.Items.Where(x => x.Value != null && !x.Unresolved)) item.Validated = true;
                return note;
            }
            // the failures that name an item drop it; what names none fails every proposal of this round
            var named = false;
            foreach (var failure in outcome.Failures)
            {
                var item = ItemOf(failure, proposal, outcome.EventActions);
                if (item == null || item.Unresolved) continue;
                var dropped = item with { Unresolved = true };
                dropped.Failure = "the offline build refused it: " + failure.Why;
                proposal.Items[proposal.Items.IndexOf(item)] = dropped;
                named = true;
                // what reads a source that did not build goes with it
                if (item.Kind == "source")
                    foreach (var dependent in proposal.Items.Where(x => !x.Unresolved && x.Owner == item.Owner && x.Kind != "source").ToList())
                    {
                        var gone = dependent with { Unresolved = true };
                        gone.Failure = $"it reads the source of {item.Key}, which the offline build refused";
                        proposal.Items[proposal.Items.IndexOf(dependent)] = gone;
                    }
            }
            if (!named)
            {
                // nothing names an item: the build is isolated, deterministically, by kind (events, then slots, then lists),
                // then one item of that kind at a time; what cannot be told apart goes as a whole
                var why = string.Join("; ", outcome.Failures.Select(f => f.Why).Take(2));
                if (Isolate(host, baseBytes, data, proposal, file, loadProducer, why, log)) continue;
                note = "the offline build failed: " + why;
                foreach (var item in proposal.Items.Where(x => !x.Unresolved).ToList())
                {
                    var dropped = item with { Unresolved = true };
                    dropped.Failure = note;
                    proposal.Items[proposal.Items.IndexOf(item)] = dropped;
                }
                log?.Invoke("prototype bind: " + note);
                return note;
            }
        }
        return note;
    }

    /// <summary>The kind whose proposals, all kept as the prototype's, let the build pass; then, inside it, each proposal whose
    /// removal alone lets it pass (at most 8 builds), else the whole kind. True when something was dropped.</summary>
    private static bool Isolate(ModelHost host, byte[] baseBytes, JsonObject data, PrototypeBindDiscovery.Proposal proposal, string file, Func<string, ServiceStudio.Model.ESpace> loadProducer, string why, Action<string>? log)
    {
        bool Passes(IReadOnlyCollection<PrototypeBindDiscovery.Item> without)
        {
            var trial = new PrototypeBindDiscovery.Proposal { Bind = proposal.Bind };
            trial.Items.AddRange(proposal.Items.Select(x => without.Contains(x) ? x with { Unresolved = true } : x));
            return Build(host, baseBytes, data, Candidate(trial), file, loadProducer).Failures.Count == 0;
        }
        void Drop(PrototypeBindDiscovery.Item item, string reason)
        {
            var dropped = item with { Unresolved = true };
            dropped.Failure = reason;
            proposal.Items[proposal.Items.IndexOf(item)] = dropped;
        }
        foreach (var kind in new[] { "event", "slot", "list" })
        {
            var group = proposal.Items.Where(x => !x.Unresolved && x.Value != null && x.Kind == kind).ToList();
            if (group.Count == 0 || !Passes(group)) continue;
            var culprits = new List<PrototypeBindDiscovery.Item>();
            foreach (var item in group.Take(8)) if (Passes([item])) culprits.Add(item);
            if (culprits.Count == 0) culprits = group;
            foreach (var item in culprits) Drop(item, "the offline build refused it: " + why);
            log?.Invoke($"prototype bind: isolated {culprits.Count} {kind}(s) the build refused");
            return true;
        }
        return false;
    }

    /// <summary>The binding the offline build uses: every live proposal; an unresolved item keeps the prototype's own value (null).</summary>
    private static JsonObject Candidate(PrototypeBindDiscovery.Proposal proposal)
    {
        var bind = proposal.Bind.DeepClone().AsObject();
        foreach (var item in proposal.Items.Where(x => x.Unresolved))
        {
            if (item.Kind == "source") { (bind[item.Section] as JsonObject)?.Remove(item.Key); continue; }
            if (bind[item.Section] is not JsonObject section) { section = new JsonObject(); bind[item.Section] = section; }
            section[item.Key] = null;
            // a list kept as the prototype's: its row slots go back to the prototype's fields too
            if (item.Kind == "list" && bind["slots"] is JsonObject slots)
                foreach (var key in slots.Select(s => s.Key).Where(k => k.StartsWith(item.Key + "/*", StringComparison.Ordinal)).ToList()) slots.Remove(key);
        }
        return bind;
    }

    /// <summary>A failure of the offline build: the capture keys of the widgets it is about, the names of the screen and data actions
    /// around it, and the text.</summary>
    private sealed record Failure(HashSet<string> Keys, HashSet<string> Actions, string Why);
    private sealed record BuildOutcome(List<Failure> Failures, JsonObject EventActions);

    /// <summary>The proposed item a failure is about: a text slot by its widget's k, a list by its own, an event by its screen action,
    /// a source by its data action; a widget of a row is its list's when no slot of the row is named.</summary>
    private static PrototypeBindDiscovery.Item? ItemOf(Failure failure, PrototypeBindDiscovery.Proposal proposal, JsonObject eventActions)
    {
        var live = proposal.Items.Where(x => !x.Unresolved && x.Value != null).ToList();
        foreach (var item in live.Where(x => x.Kind == "slot"))
            if (failure.Keys.Contains(item.Key.Split('@')[0])) return item;
        foreach (var item in live.Where(x => x.Kind == "list"))
            if (failure.Keys.Any(k => k == item.Key || k.StartsWith(item.Key + "/", StringComparison.Ordinal))) return item;
        foreach (var item in live.Where(x => x.Kind == "event"))
            if (eventActions[item.Key]?.ToString() is { } action && failure.Actions.Contains(action)) return item;
        foreach (var item in live.Where(x => x.Kind == "source"))
        {
            var name = item.Value?["source"]?["as"]?.ToString() ?? item.Value?["source"]?["action"]?.ToString();
            if (name != null && failure.Actions.Contains(name)) return item;
        }
        // a node only one kind of proposal writes (the download of a file, a feedback message): the event that asks for it
        foreach (var (node, then) in new[] { ("IDownloadNode", "download"), ("IMessageNode", "message") })
            if (failure.Why.Contains(node, StringComparison.Ordinal)
                && live.FirstOrDefault(x => x.Kind == "event" && (x.Value?["then"] as JsonArray ?? []).Any(t => t?.ToString()?.StartsWith(then, StringComparison.Ordinal) == true)) is { } asking)
                return asking;
        // an apply failure names the elements in its text: the most specific first (a slot's k, a list's, an event, a source)
        foreach (var item in live.OrderBy(x => x.Kind switch { "slot" => 0, "list" => 1, "event" => 2, _ => 3 }))
        {
            var markers = item.Kind switch
            {
                "event" => [item.Value?["call"]?.ToString(), eventActions[item.Key]?.ToString()],
                "source" => new[] { item.Value?["source"]?["as"]?.ToString(), item.Value?["source"]?["action"]?.ToString() },
                _ => [item.Key],
            };
            if (markers.OfType<string>().Any(m => failure.Why.Contains(m, StringComparison.Ordinal))) return item;
        }
        return null;
    }

    private static BuildOutcome Build(ModelHost host, byte[] baseBytes, JsonObject data, JsonObject bind, string file, Func<string, ServiceStudio.Model.ESpace> loadProducer)
    {
        var failures = new List<Failure>();
        var candidate = data.DeepClone().AsObject();
        candidate["bind"] = bind;
        candidate["_validate"] = true;
        var scratch = host.Load(baseBytes);
        try
        {
            var session = new ModelSession(scratch) { ProducerLoader = spec => loadProducer(spec) };
            if (file.EndsWith(".avsig", StringComparison.OrdinalIgnoreCase))
                session.PrepareSignatureReference(new JsonObject { ["op"] = "reference", ["producer"] = file, ["elements"] = new JsonArray(PrototypeBind.ElementsOf(bind).Select(e => (JsonNode)e).ToArray()) }, NativeReferenceSnapshot.Read(file));
            var before = ModelHost.Messages(scratch);
            session.OpsPointer = "/ops";
            session.KeepFailures = true;
            var results = session.Apply(new JsonArray(new JsonObject { ["op"] = "prototype", ["data"] = candidate }));
            if (session.Kept is { } kept)
            {
                foreach (var problem in kept.Problems) failures.Add(new([], [], Clip(problem["message"]?.ToString() ?? "")));
                return new BuildOutcome(failures, new JsonObject());
            }
            var report = results.OfType<JsonObject>().FirstOrDefault()?["result"]?["prototype"] as JsonObject;
            var widgetKeys = report?["widgetKeys"] as JsonObject ?? new JsonObject();
            var eventActions = report?["eventActions"] as JsonObject ?? new JsonObject();
            var delta = MessageDelta.Compute(before, ModelHost.Messages(scratch));
            foreach (var message in delta.New.Where(m => m.IsError))
            {
                var keys = new HashSet<string>(StringComparer.Ordinal);
                var actions = new HashSet<string>(StringComparer.Ordinal);
                for (var o = message.Owner as IObjectSignature; o != null; o = o.Parent as IObjectSignature)
                {
                    if (o.ObjectKey?.ToString() is { } key && widgetKeys[key]?.ToString() is { } k) keys.Add(k);
                    if ((ModelSession.Implements(o, "IScreenAction") || ModelSession.Implements(o, "IDataAction")) && TypeResolver.Name(o) is { } name) actions.Add(name);
                }
                failures.Add(new(keys, actions, Clip($"{message.Id}: {message.Detail} @ {message.Path}")));
            }
            return new BuildOutcome(failures, eventActions);
        }
        catch (Exception ex) { failures.Add(new([], [], Clip(Errors.Text(ex)))); return new BuildOutcome(failures, new JsonObject()); }
        finally { ModelHost.Release(scratch); }
    }

    /// <summary>The cause of a failure (the innermost exception's text, where the Studio says what it refuses), at most 400 characters.</summary>
    private static string Clip(string text)
    {
        var at = text.LastIndexOf("Exception: ", StringComparison.Ordinal);
        if (at >= 0 && at + 11 < text.Length) text = text[(at + 11)..];
        // the proposal is the binding's, not a defect of the SSAM: what the Studio refuses is said as it is
        text = text.Replace(" (a generated op: a defect of the SSAM)", "", StringComparison.Ordinal);
        return text.Length > 400 ? text[..397] + "..." : text;
    }
}
