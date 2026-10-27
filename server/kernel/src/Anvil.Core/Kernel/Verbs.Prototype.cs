using System.Diagnostics;
using System.Reflection;
using System.Text.Json.Nodes;
using OutSystems.Model;
using ServiceStudio.Model;

namespace Anvil.Core;

/// <summary>
/// op prototype (docs/PROTOTIPO-NATIVO.md): the capture bundle written by the facade becomes native screens, a shell block, popups,
/// data and logic in one op. The plan comes from <see cref="PrototypeExpander"/>; module elements and logic go through the existing
/// verbs (ApplyOne), the widgets through the direct builder (<see cref="PrototypeBuilder"/>), the theme stylesheet straight into
/// the Model API without CodeFormat (the prototype CSS is written verbatim), and the built roots are read back by
/// PrototypeSeams.Render into prototype-dom.json for the fidelity measure.
/// </summary>
public sealed partial class ModelSession
{
    /// <summary>The few session services the direct builder needs, without exposing the session.</summary>
    internal sealed class PrototypeAccess(ModelSession session, PrototypePlan plan)
    {
        public object? Owner { get; set; }
        public object Resolve(string reference) => session.Resolve(reference);
        public void Register(string alias, object value) => session.Register(alias, value);
        public IReadOnlyList<(MethodInfo Method, bool Generic, Type Target)> FindCreate(object parent, string type) => session.FindCreate(parent, type);
        public string ScreenRef(string screen) => plan.OwnerRefs.TryGetValue(screen, out var r) ? r : "IMobileScreen:" + screen;
        public string BlockRef(string block) => plan.OwnerRefs.TryGetValue(block, out var r) ? r : "IMobileBlock:" + block;
        /// <summary>A screen action of the owner being built, by name (the owner is in hand: no module scan).</summary>
        public object? Action(string name)
            => Owner is IObjectSignature o ? o.Children.OfType<IObjectSignature>().FirstOrDefault(c => Implements(c, "IScreenAction") && string.Equals(TypeResolver.Name(c), name, StringComparison.OrdinalIgnoreCase)) : null;
        public static string? ArgumentNameOf(object child) => ArgumentName(child);
    }

    /// <summary>The model keys of the widgets the prototype ops of this session built -> their capture k (1.4.1).</summary>
    private readonly Dictionary<string, string> _prototypeKeys = new(StringComparer.Ordinal);

    /// <summary>The capture k of the generated element that holds <paramref name="owner"/> (itself or the nearest ancestor a
    /// prototype op built), or null: a Verify message on a property object of a widget names that widget's k.</summary>
    internal (string K, string Key)? PrototypeOrigin(IObjectSignature? owner)
    {
        if (_prototypeKeys.Count == 0) return null;
        for (var o = owner; o != null && o is not IESpace; o = o.Parent as IObjectSignature)
            if (o.ObjectKey?.ToString() is { } key && _prototypeKeys.TryGetValue(key, out var k)) return (k, key);
        return null;
    }

    private JsonNode Prototype(JsonObject op)
    {
        var total = Stopwatch.StartNew();
        var data = op["data"] as JsonObject ?? throw new InvalidOperationException("prototype: 'data' is required (api --op prototype)");
        var problems = new List<PrototypeCapture.Problem>();
        var capture = PrototypeCapture.Load(data, problems);
        if (capture == null || problems.Count > 0) throw PrototypeRefusal(problems);
        // data.bind (2.12): the capture's collections, texts and events bound to the producer's published actions
        var validating = data["_validate"]?.GetValue<bool>() == true;
        if (data["bind"] is JsonObject bind)
        {
            var producer = BoundProducer(bind, data, problems);
            if (producer == null) throw PrototypeRefusal(problems);
            var bound = PrototypeBind.Apply(capture, bind, producer, data["_producer"]?.ToString());
            if (bound.Problems.Count > 0) throw PrototypeRefusal(bound.Problems);
            // the job runner proposes the bindings before the apply (PrototypeBindPrepass); an op that still lacks one refuses
            // here with what it lacks, never imports mock data in place of the producer's
            if (!validating && (bound.Unbound.Count > 0 || !PrototypeBind.HasBindings(bind)))
                throw PrototypeRefusal(bound.Unbound.Select(u => new PrototypeCapture.Problem(PrototypeBind.Required, "/bind/" + (u.Kind == "list" ? "lists" : u.Kind == "slot" ? "slots" : "events") + "/" + PrototypeBind.Esc(u.Key),
                    $"prototype: {u.Kind} {u.Key} ({u.View}) needs a binding to {producer.Name}: {u.Why}", false, null)).DefaultIfEmpty(new(PrototypeBind.Required, "/bind",
                    $"prototype: bind names only its producer: the job runner proposes the bindings (run it through o11_job/o11_deliver)", false, null)).ToList());
            var samples = PrototypeBindSamples.Build(bound.Json, bound.Plan, producer, capture.Json["clock"]?.ToString());
            foreach (var (owner, value) in samples.Samples) bound.Plan.Samples[owner] = value?.DeepClone();
            bound.Plan.Report["samples"] = new JsonObject { ["explained"] = samples.Explained.Count, ["unexplained"] = samples.Unexplained.DeepClone(), ["values"] = samples.Samples.DeepClone() };
            bound.Plan.Report["kept"] = new JsonArray(bound.Unbound.Select(u => (JsonNode)new JsonObject { ["kind"] = u.Kind, ["k"] = u.Key, ["why"] = u.Why }).ToArray());
            // what only the prototype's script did at runtime: its timers refresh values the native screen shows as fetched
            var runtime = new JsonArray();
            foreach (var timer in PrototypeCapture.Objects(capture.Json["outOfScope"]).Where(o => o["what"]?.ToString() is { } w && (w.Contains("setInterval", StringComparison.Ordinal) || w.Contains("timer", StringComparison.OrdinalIgnoreCase))))
                runtime.Add(new JsonObject
                {
                    ["what"] = timer["what"]?.DeepClone(), ["where"] = timer["where"]?.DeepClone(),
                    ["native"] = "no client timer without JavaScript (owner's rule): the bound values are those of the last fetch of their Data Action (the screen's load, and the refresh after each event); a running counter needs the elapsed time from the server or a refresh",
                });
            if (runtime.Count > 0) bound.Plan.Report["runtime"] = runtime;
            capture = capture.Rebound(bound.Json, bound.Plan);
        }
        var module = PrototypeModuleView();
        var plan = PrototypeExpander.Plan(capture, module, PrototypeExpander.Current);
        if (plan.Problems.Count > 0) throw PrototypeRefusal(plan.Problems);
        // the collisions the plan carries in itself come all at once, before any op runs, each with its verified name map
        if (PrototypePlannedCollisions(plan, capture, module, PrototypeExpander.Current) is { Count: > 0 } planned)
            throw new KernelRefusalException(PrototypeCapture.NameCollision, $"prototype: {planned.Count} name collision(s) inside the plan, all reported at once: " + string.Join(" | ", planned.Select(p => p["message"]!.ToString())),
                new JsonArray(planned.Select(p => (JsonNode)p).ToArray()));
        var expandMs = total.ElapsedMilliseconds;
        var report = plan.Report;
        var timings = new JsonObject { ["expandMs"] = expandMs };
        report["timings"] = timings;
        if (plan.NoChange)
        {
            report["code"] = "NO_CHANGE";
            timings["buildMs"] = total.ElapsedMilliseconds;
            return new JsonObject { ["prototype"] = report, ["noChange"] = true };
        }
        var access = new PrototypeAccess(this, plan);
        var builder = new PrototypeBuilder(access, plan.Platform);
        // The footprint (B3) keeps, once, every root this import changes that existed before (the module, the marked elements
        // it updates); then the generated ops run without the per-op scope bookkeeping, which grows with every op and would
        // cost more than the ops themselves. New elements are found under the kept roots at the end, as for any job.
        var footprint = _footprintBegun;
        if (footprint)
            foreach (var reference in plan.OwnerRefs.Values.Concat(plan.ExistingRefs).Concat(plan.Vanished.Select(v => "@" + v.Key)).Where(r => r.StartsWith('@')).Distinct(StringComparer.Ordinal))
                try { if (Resolve(reference) is IObjectSignature root) Keep(root, deep: true); } catch (KeyNotFoundException) { }
        long opsMs = 0, widgetsMs = 0, logicMs = 0;
        var popupObjects = new Dictionary<string, object>(StringComparer.Ordinal);
        var phases = new JsonArray();
        _footprintBegun = false;
        try
        {
        foreach (var step in plan.Steps)
        {
            var sw = Stopwatch.StartNew();
            if (step.Ops != null)
            {
                for (var i = 0; i < step.Ops.Count; i++)
                {
                    try { ApplyOne(step.Ops[i]); }
                    catch (Exception ex)
                    {
                        var generated = step.Ops[i];
                        // A name the planner did not reserve and the Studio renamed: the refusal carries the name map that
                        // makes the next call right (mapping.names), never a bare "a defect of the SSAM".
                        if (PrototypeCollision(ex, capture, step.Label, generated, module) is { } collision) throw collision;
                        throw new InvalidOperationException($"prototype step '{step.Label}' op #{i} ({generated["op"]} {generated["type"] ?? generated["prop"]} {generated["name"] ?? generated["target"]}): {Unwrap(ex)} (a generated op: a defect of the SSAM)", ex);
                    }
                }
                if (step.Phase.StartsWith("logic", StringComparison.Ordinal)) logicMs += sw.ElapsedMilliseconds; else opsMs += sw.ElapsedMilliseconds;
            }
            else if (step.Widgets is { } job)
            {
                var owner = Resolve(job.Owner);
                var parent = Resolve(job.Parent);
                access.Owner = owner;
                builder.Build(job, parent);
                foreach (var root in job.Roots.Where(r => r.W == "IPopup" && r.K != null && !popupObjects.ContainsKey(r.K)))
                    if (job.Specs.TryGetValue(root, out var spec) && spec.Name != null && FindNamedWidget(owner, spec.Name) is { } popup) popupObjects[root.K!] = popup;
                widgetsMs += sw.ElapsedMilliseconds;
                _byKey = null;
            }
            else if (step.Special == "stylesheet")
            {
                // verbatim: never through CodeFormat (the set verb and InstallStylesheet format; the importer's stylesheet must not)
                var theme = Resolve(step.Arguments!["theme"]!.ToString());
                var property = FindProperty(theme, "StyleSheet") ?? throw new InvalidOperationException("the theme has no StyleSheet");
                property.SetValue(theme, step.Arguments["styleSheet"]!.ToString());
                // T18: through the one tail of every stylesheet write (split or not), without the canvas rewrite: verbatim. The
                // prototype import is off (PrototypeImport), so this runs only where a test drives the builder.
                if (ThemeCss.Of(theme) is { } sheet) ThemeCss.Settle(sheet);
                ThemeWritten(theme);
                // M1 of the review of round 6 (round 7 of fix/data-table): the native layout block the plan put in the import's theme
                // (nativeLayout: F1 of the html op on a List that is a table part) is said in normalized too, where the job says the
                // other rules it writes in a theme (THEME_NATIVE_WIDGETS) and the html op the block it writes (InstallNativeLayout).
                if (report["nativeLayout"] is JsonObject layout) Report("normalized", NativeLayoutWritten(layout));
                opsMs += sw.ElapsedMilliseconds;
            }
            else if (step.Special == "handles")
            {
                // the canonical references of the screens and blocks just declared ("IMobileScreen:Name"): the logic op's
                // destinations and triggers find them as handles instead of scanning the module once per reference
                foreach (var (reference, target) in step.Arguments!)
                    if (Resolve(target!.ToString()) is { } element) Register(reference, element);
            }
            else if (step.Special == "clear")
            {
                PrototypeClear(Resolve(step.Arguments!["owner"]!.ToString()), step.Arguments["kind"]!.ToString());
                opsMs += sw.ElapsedMilliseconds;
            }
            else if (step.Special == "vanished")
            {
                var (removed, kept) = PrototypeVanished(plan);
                report["removed"] = removed; report["kept"] = kept;
                opsMs += sw.ElapsedMilliseconds;
            }
            else if (step.Special == "flow-description")
            {
                var flow = Resolve(step.Arguments!["flow"]!.ToString());
                FindProperty(flow, "Description")!.SetValue(flow, step.Arguments["description"]!.ToString());
            }
            else if (step.Special == "render" && validating) { }
            else if (step.Special == "render")
            {
                var renderMs = Stopwatch.StartNew();
                report["nativeDom"] = PrototypeRender(plan, capture, popupObjects, builder.Keys);
                timings["renderMs"] = renderMs.ElapsedMilliseconds;
            }
            phases.Add(new JsonObject { ["phase"] = step.Phase, ["label"] = step.Label, ["ms"] = sw.ElapsedMilliseconds, ["ops"] = step.Ops?.Count });
        }
        }
        finally { _footprintBegun = footprint; }
        timings["opsMs"] = opsMs; timings["logicMs"] = logicMs; timings["widgetsMs"] = widgetsMs; timings["buildMs"] = total.ElapsedMilliseconds;
        report["steps"] = phases;
        report["builder"] = new JsonObject { ["widgets"] = builder.Widgets, ["extendedProperties"] = builder.ExtendedProperties, ["problems"] = new JsonArray(builder.Problems.Select(p => (JsonNode)p).ToArray()) };
        if (builder.Problems.Count > 0 && report["degraded"] is JsonArray degraded) foreach (var p in builder.Problems) degraded.Add(p.DeepClone());
        // the widget keys -> capture keys, for the deterministic degradation of 1.4.1: the Verify of this session names the k of
        // the generated element that holds each message (VerifyProblems walks the owner's parents up to a built widget); the
        // offline build that validates a binding proposal (PrototypeBindPrepass) reads them inline and writes nothing
        foreach (var (key, k) in builder.Keys) _prototypeKeys[key] = k;
        if (validating)
        {
            report["widgetKeys"] = new JsonObject(builder.Keys.Select(k => KeyValuePair.Create(k.Key, (JsonNode?)k.Value)));
            report["eventActions"] = new JsonObject(plan.EventActions.Select(e => KeyValuePair.Create(e.Key, (JsonNode?)e.Value)));
        }
        else
        {
            var keysPath = Path.Combine(capture.BundleRoot, "prototype-keys.json");
            try { File.WriteAllText(keysPath, new JsonObject(builder.Keys.Select(k => KeyValuePair.Create(k.Key, (JsonNode?)k.Value))).ToJsonString()); report["keys"] = keysPath; }
            catch (IOException) { }
        }
        Report("prototype", new JsonObject { ["flow"] = plan.FlowName, ["screens"] = plan.Screens.Count, ["buildMs"] = total.ElapsedMilliseconds });
        return new JsonObject { ["prototype"] = report };
    }

    /// <summary>The normalized entry of the native layout block an import wrote in its theme (round 7 of fix/data-table): the code and
    /// the fields of the html op's entry (THEME_NATIVE_LAYOUT: theme, written, action, version), the count of the Lists it lays out,
    /// the count of the markers the prototype writes itself when there are any (B2) and the note of the import's report (nativeLayout).</summary>
    private static JsonObject NativeLayoutWritten(JsonObject layout)
    {
        var entry = new JsonObject
        {
            ["code"] = ScreenVisual.ThemeNativeLayout, ["theme"] = layout["theme"]?.DeepClone(), ["written"] = true, ["action"] = layout["action"]?.DeepClone(),
            ["version"] = layout["version"]?.DeepClone(), ["lists"] = layout["lists"]?["count"]?.DeepClone() ?? JsonValue.Create(0),
        };
        if (layout["prototypeMarkers"]?["count"] is { } marked) entry["prototypeMarkers"] = marked.DeepClone();
        entry["note"] = layout["note"]?.DeepClone();
        return entry;
    }

    /// <summary>The public surface of data.bind's producer: read from its model when it is bound as an .oml (the plan then references
    /// what it uses), else from the reference the module already holds (an .avsig imported before the edit transaction, or a
    /// reference of an earlier delivery).</summary>
    private PrototypeProducer? BoundProducer(JsonObject bind, JsonObject data, List<PrototypeCapture.Problem> problems)
    {
        var name = bind["producer"]?.ToString() ?? "";
        var file = data["_producer"]?.ToString();
        if (file != null && !file.EndsWith(".avsig", StringComparison.OrdinalIgnoreCase) && ProducerLoader != null)
        {
            var producer = ProducerLoader(file);
            return PrototypeProducer.Read(TypeResolver.Name(producer) ?? name, ((IObjectSignature)producer).Children.Cast<object>(), publicOnly: true);
        }
        // the module name of a frozen signature (the binding may name it otherwise: "Name=Producer")
        if (file != null && file.EndsWith(".avsig", StringComparison.OrdinalIgnoreCase) && File.Exists(file)) name = NativeReferenceSnapshot.Read(file).Name;
        var reference = _espace.References.FirstOrDefault(r => string.Equals(r.Name, name, StringComparison.OrdinalIgnoreCase));
        if (reference != null) return PrototypeProducer.Read(name, ((IObjectSignature)reference).Children.Cast<object>(), publicOnly: false);
        problems.Add(new("INPUT_INVALID", "/bind/producer", $"prototype: the producer {name} is not bound to this job: the delivery captures it (producers \"published\") or "
            + $"the call names its file (producers {{\"{name}\": \"<.oml or .avsig>\"}})", false, null));
        return null;
    }

    private static object? FindNamedWidget(object owner, string name)
        => owner is IObjectSignature o ? o.GetAllDescendantsOfType<IObjectSignature>().FirstOrDefault(c => c is OutSystems.Model.UI.IWidget && string.Equals(TypeResolver.Name(c), name, StringComparison.Ordinal)) : null;

    /// <summary>One refusal with every problem (1.4): PROTOTYPE_IR_INVALID (ssamDefect) for the capture, PROTOTYPE_NAME_COLLISION for a
    /// requested name, INPUT_INVALID for a key outside the contract; each with its pointer into the job and the patch.</summary>
    private Exception PrototypeRefusal(List<PrototypeCapture.Problem> problems)
    {
        // inside a job's apply the failed op's problems are rebased onto the job by the apply (ApplyProblems: relative to op.data),
        // so they stay relative here; a direct call (the bridge) answers relative to the op
        var at = OpsPointer != null && _applyOps != null && _applyIndex < _applyOps.Count ? "" : "/data";
        var code = problems.Any(p => p.Code == PrototypeCapture.IrInvalid) ? PrototypeCapture.IrInvalid
            : problems.Any(p => p.Code == PrototypeCapture.NameCollision) ? PrototypeCapture.NameCollision : problems.FirstOrDefault()?.Code ?? PrototypeCapture.IrInvalid;
        var array = new JsonArray();
        foreach (var p in problems)
        {
            var patch = p.Patch == null ? null : new JsonArray(p.Patch.OfType<JsonObject>().Select(x => { var c = x.DeepClone().AsObject(); c["path"] = at + c["path"]; return (JsonNode)c; }).ToArray());
            var problem = JobPreflight.Problem(_applyIndex, at + p.Pointer, p.Code, "error", p.Message, p.SsamDefect ? "a defect of the SSAM: the facade recaptures the prototype; nothing to change in the job" : null, patch);
            if (p.SsamDefect) problem["ssamDefect"] = true;
            if (p.IrPath != null) problem["irPath"] = p.IrPath;
            array.Add(JobPreflight.PublicProblem(problem));
        }
        return new KernelRefusalException(code, $"prototype: {problems.Count} problem(s), all reported at once: " + string.Join(" | ", problems.Select(p => p.Message)), array);
    }

    /// <summary>The key of <see cref="Exception.Data"/> where a create renamed by the Studio leaves its facts (Create, A04).</summary>
    internal const string NameCollisionData = "ssam.nameCollision";

    /// <summary>A generated op the Studio renamed (a name the planner's reservation did not cover): PROTOTYPE_NAME_COLLISION with the
    /// ready name map instead of an SSAM defect with no correction. The patch (relative to the op's data, rebased onto the job by
    /// the apply) adds mapping.names "&lt;Owner&gt;/&lt;Name&gt;" (a member of a screen or block) or "&lt;Name&gt;" (a module element)
    /// with the free name; the planner then keeps the generated name reserved and uses that one in every reference.</summary>
    private KernelRefusalException? PrototypeCollision(Exception error, PrototypeCapture capture, string step, JsonObject generated, PrototypeModule module)
    {
        if (PrototypeCollisionProblem(error, capture.Data, step) is not { } problem) return null;
        // the owner's rule: a patch is offered only after the plan ran again with it and the colliding name was gone
        var unresolved = PrototypeCollisionUnresolved(problem, capture, generated, module, PrototypeExpander.Current);
        if (unresolved != null) problem = PrototypeCollisionWithoutPatch(problem, unresolved);
        var item = JobPreflight.Problem(_applyOps != null ? _applyIndex : (int?)null, problem["pointer"]!.ToString(), PrototypeCapture.NameCollision, "error",
            problem["message"]!.ToString(), problem["fix"]!.ToString(), (problem["patch"] as JsonArray)?.DeepClone().AsArray());
        if (unresolved != null) { item["ssamDefect"] = true; item["unresolved"] = true; }
        return new KernelRefusalException(PrototypeCapture.NameCollision, "prototype: " + problem["message"], new JsonArray(JobPreflight.PublicProblem(item)));
    }

    /// <summary>Why the name map of a collision would not resolve it (null when it does): the map is already in the call (the
    /// loop of 2026-10-12, mapping.names {label: label2} twice), or the plan made again with it, over the same view of the module,
    /// still generates the colliding element. The same rule as the capture's refusals (capture.mjs, mappingAdditions).</summary>
    internal static string? PrototypeCollisionUnresolved(JsonObject problem, PrototypeCapture capture, JsonObject generated, PrototypeModule module, PrototypeExpander.Seams seams)
    {
        if (problem["names"] is not JsonObject names || names.Count == 0) return "no name map to propose";
        var given = capture.Mapping["names"] as JsonObject;
        foreach (var (key, value) in names)
            if (given?[key] is JsonValue was && was.ToString() == value?.ToString()) return $"mapping.names already maps {key} to {value} in this call and the Studio still renamed the element";
        var data = capture.Data.DeepClone().AsObject();
        if (data["mapping"] is not JsonObject mapping) data["mapping"] = mapping = new JsonObject();
        if (mapping["names"] is not JsonObject merged) mapping["names"] = merged = new JsonObject();
        foreach (var (key, value) in names) merged[key] = value?.DeepClone();
        var problems = new List<PrototypeCapture.Problem>();
        PrototypePlan plan;
        try
        {
            var again = PrototypeCapture.Load(data, problems);
            if (again == null || problems.Count > 0) return "the capture with the name map does not load: " + string.Join("; ", problems.Select(p => p.Message).Take(3));
            plan = PrototypeExpander.Plan(again, module, seams);
        }
        catch (Exception ex) { return "the plan with the name map failed: " + Unwrap(ex); }
        if (plan.Problems.Count > 0) return "the plan with the name map refuses: " + string.Join("; ", plan.Problems.Select(p => p.Message).Take(3));
        var type = generated["type"]?.ToString(); var parent = generated["parent"]?.ToString(); var name = generated["name"]?.ToString();
        var still = plan.Steps.Where(s => s.Ops != null).SelectMany(s => s.Ops!).Any(o => o["op"]?.ToString() == "create" && o["type"]?.ToString() == type
            && o["parent"]?.ToString() == parent && string.Equals(o["name"]?.ToString(), name, StringComparison.OrdinalIgnoreCase));
        return still ? $"the plan made again with mapping.names {names.ToJsonString()} still generates the {type} '{name}' under {parent}" : null;
    }

    /// <summary>Two creates of one type under one parent whose names are equal ignoring case (the Model API compares that way
    /// and renames the second): (parent, type, name of the second, name of the first).</summary>
    internal static List<(string Parent, string Type, string Name, string First)> PrototypeDuplicateCreates(PrototypePlan plan)
    {
        var seen = new Dictionary<(string, string), Dictionary<string, string>>();
        var found = new List<(string, string, string, string)>();
        // (named planned, never op: SurfaceTests takes every read of a variable named op in this file as a key of the verb)
        foreach (var planned in plan.Steps.Where(s => s.Ops != null).SelectMany(s => s.Ops!))
        {
            if (planned["op"]?.ToString() != "create" || planned["parent"]?.ToString() is not { Length: > 0 } parent || parent == "@espace"
                || planned["type"]?.ToString() is not { Length: > 0 } type || planned["name"]?.ToString() is not { Length: > 0 } name) continue;
            if (!seen.TryGetValue((parent, type), out var names)) seen[(parent, type)] = names = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (names.TryGetValue(name, out var first)) found.Add((parent, type, name, first)); else names[name] = name;
        }
        return found;
    }

    /// <summary>The collisions a plan carries in itself (<see cref="PrototypeDuplicateCreates"/>), every one as a problem: the name
    /// map "&lt;Owner&gt;/&lt;Name&gt;" -> the first free &lt;Name&gt;N, offered only when the plan made again with the whole map has
    /// none of them left (else without patch, ssamDefect, unresolved).</summary>
    internal static List<JsonObject> PrototypePlannedCollisions(PrototypePlan plan, PrototypeCapture capture, PrototypeModule module, PrototypeExpander.Seams seams)
    {
        var duplicates = PrototypeDuplicateCreates(plan);
        if (duplicates.Count == 0) return [];
        var owners = plan.OwnerRefs.ToDictionary(p => p.Value, p => p.Key, StringComparer.Ordinal);
        string? OwnerOf(string parent)
        {
            if (owners.TryGetValue(parent, out var owner)) return owner;
            foreach (var (entity, collection) in plan.EntityCollections)
                if (parent == "$p.ent." + PrototypePlanner.Safe(collection)) return entity;
            return null;
        }
        var taken = plan.Steps.Where(s => s.Ops != null).SelectMany(s => s.Ops!).Where(o => o["op"]?.ToString() == "create")
            .GroupBy(o => o["parent"]?.ToString() ?? "").ToDictionary(g => g.Key, g => new HashSet<string>(g.Select(o => o["name"]?.ToString() ?? ""), StringComparer.OrdinalIgnoreCase));
        var names = new JsonObject();
        var entries = new List<(string Parent, string Type, string Name, string First, string? Key, string? Free)>();
        foreach (var (parent, type, name, first) in duplicates)
        {
            var owner = OwnerOf(parent);
            string? free = null;
            if (owner != null) { var n = 2; do free = name + n++; while (taken[parent].Contains(free)); taken[parent].Add(free); names[owner + "/" + name] = free; }
            entries.Add((parent, type, name, first, owner != null ? owner + "/" + name : null, free));
        }
        // the whole map planned again over the same view of the module: which duplicates are still there
        HashSet<(string, string, string)>? left = null;
        string? why = null;
        if (names.Count > 0)
        {
            var data = capture.Data.DeepClone().AsObject();
            if (data["mapping"] is not JsonObject mapping) data["mapping"] = mapping = new JsonObject();
            if (mapping["names"] is not JsonObject merged) mapping["names"] = merged = new JsonObject();
            foreach (var (key, value) in names) if (merged[key] == null) merged[key] = value?.DeepClone();
            var problems = new List<PrototypeCapture.Problem>();
            try
            {
                var again = PrototypeCapture.Load(data, problems);
                if (again == null || problems.Count > 0) why = "the capture with the name map does not load";
                else
                {
                    var replanned = PrototypeExpander.Plan(again, module, seams);
                    if (replanned.Problems.Count > 0) why = "the plan with the name map refuses: " + string.Join("; ", replanned.Problems.Select(p => p.Message).Take(2));
                    else left = new HashSet<(string, string, string)>(PrototypeDuplicateCreates(replanned).Select(d => (d.Parent, d.Type, d.Name.ToLowerInvariant())));
                }
            }
            catch (Exception ex) { why = "the plan with the name map failed: " + Unwrap(ex); }
        }
        var output = new List<JsonObject>();
        static string Escape(string token) => token.Replace("~", "~0").Replace("/", "~1");
        // the patches of the refusal together are one valid call: the first creates mapping/names, the others add to it
        var hasMapping = capture.Data["mapping"] is JsonObject;
        var hasNames = capture.Data["mapping"]?["names"] is JsonObject;
        JsonObject PatchOf(string key, string free)
        {
            if (!hasMapping) { hasMapping = hasNames = true; return new JsonObject { ["op"] = "add", ["path"] = "/mapping", ["value"] = new JsonObject { ["names"] = new JsonObject { [key] = free } } }; }
            if (!hasNames) { hasNames = true; return new JsonObject { ["op"] = "add", ["path"] = "/mapping/names", ["value"] = new JsonObject { [key] = free } }; }
            return new JsonObject { ["op"] = "add", ["path"] = "/mapping/names/" + Escape(key), ["value"] = free };
        }
        foreach (var e in entries)
        {
            var resolved = e.Key != null && why == null && left != null && !left.Contains((e.Parent, e.Type, e.Name.ToLowerInvariant()));
            var message = $"the plan creates the {e.Type} '{e.Name}' next to '{e.First}' under {e.Key?.Split('/')[0] ?? e.Parent}: the Studio compares names ignoring case and would rename it";
            var problem = JobPreflight.Problem(null, "/mapping/names" + (e.Key != null ? "/" + Escape(e.Key) : ""), PrototypeCapture.NameCollision, "error",
                resolved ? message + $"; mapping.names maps {e.Key} to {e.Free} (planned again: no collision left)" : message + " — no name map resolves it: " + (why ?? (e.Key == null ? "its owner has no name the map can use" : "the plan made again still creates it")),
                resolved ? $"apply the patch (mapping.names {{\"{e.Key}\": \"{e.Free}\"}}) with the others of this refusal in ONE call" : "No mapping resolves this collision; do not retry with mapping.names: report it as an SSAM defect with this refusal.",
                resolved ? new JsonArray(PatchOf(e.Key!, e.Free!)) : null);
            if (!resolved) { problem["ssamDefect"] = true; problem["unresolved"] = true; }
            output.Add(JobPreflight.PublicProblem(problem));
        }
        return output;
    }

    /// <summary>The collision as a problem with no patch: an SSAM defect the model must not loop on.</summary>
    internal static JsonObject PrototypeCollisionWithoutPatch(JsonObject problem, string why)
    {
        var copy = problem.DeepClone().AsObject();
        copy.Remove("patch");
        copy["message"] = problem["message"] + " — no name map resolves it: " + why;
        copy["fix"] = "No mapping resolves this collision (the importer applied the map it would propose and planned again); do not retry with mapping.names: report it as an SSAM defect with this refusal.";
        copy["ssamDefect"] = true; copy["unresolved"] = true;
        return copy;
    }

    /// <summary>The problem of <see cref="PrototypeCollision"/> (pointer and patch relative to the op's data), or null when the
    /// error is no Studio rename.</summary>
    internal static JsonObject? PrototypeCollisionProblem(Exception error, JsonObject data, string step)
    {
        JsonObject? facts = null;
        for (var e = error; e != null && facts == null; e = e.InnerException)
            if (e.Data[NameCollisionData] is string json) facts = JsonNode.Parse(json) as JsonObject;
        if (facts?["name"]?.ToString() is not { Length: > 0 } name || facts["actual"]?.ToString() is not { Length: > 0 } actual) return null;
        var parentType = facts["parentType"]?.ToString();
        var parentName = facts["parentName"]?.ToString();
        // a member of a screen or block, or an attribute of an entity, static entity or structure: "<Owner>/<Name>" (the planner
        // reads an entity's from its name scope, PrototypeFieldNames); a module element: "<Name>"
        var member = parentType is "IMobileScreen" or "IMobileBlock" or "IScreen" or "IBlock" or "IServerEntity" or "IStaticEntity" or "IStructure" or "IClientEntity" && parentName is { Length: > 0 };
        var key = member ? parentName + "/" + name : name;
        static string Escape(string token) => token.Replace("~", "~0").Replace("/", "~1");
        var mapping = data["mapping"] as JsonObject;
        var patch = mapping == null
            ? new JsonObject { ["op"] = "add", ["path"] = "/mapping", ["value"] = new JsonObject { ["names"] = new JsonObject { [key] = actual } } }
            : mapping["names"] is not JsonObject
                ? new JsonObject { ["op"] = "add", ["path"] = "/mapping/names", ["value"] = new JsonObject { [key] = actual } }
                : new JsonObject { ["op"] = "add", ["path"] = "/mapping/names/" + Escape(key), ["value"] = actual };
        var holder = facts["taken"]?.ToString() is { Length: > 0 } taken ? taken : "an element of the module";
        var where = member ? $"{parentType} '{parentName}'" : "the module";
        return new JsonObject
        {
            ["pointer"] = "/mapping/names/" + Escape(key),
            ["message"] = $"step '{step}': the generated {facts["type"]} '{name}' of {where} collides with {holder} and the Studio renamed it to '{actual}' "
                + $"(a name the reservation of the importer did not cover); nothing was applied. mapping.names maps {key} to {actual}: every reference of the import uses that name.",
            ["fix"] = $"apply the patch (mapping.names {{\"{key}\": \"{actual}\"}}) and call again; the rest of the call stays as it is",
            ["patch"] = new JsonArray(patch),
            ["names"] = new JsonObject { [key] = actual },
        };
    }

    /// <summary>What the planner reads of this module: the elements that share a name scope with the importation, their marks,
    /// and the attributes and records of entities (for an import in place).</summary>
    private PrototypeModule PrototypeModuleView()
    {
        var elements = new List<PrototypeElement>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        void Add(IObjectSignature o)
        {
            var kind = ShortType(o);
            if (kind is not ("IMobileScreen" or "IMobileBlock" or "IMobileFlow" or "IMobileTheme" or "IServerEntity" or "IStaticEntity" or "IStructure" or "IClientEntity"
                or "IServerAction" or "IServiceAction" or "IClientAction" or "IClientVariable" or "IImage" or "IResource" or "IUserException")) return;
            if (TypeResolver.Name(o) is not { Length: > 0 } name || o.ObjectKey == null || !seen.Add(o.ObjectKey.ToString()!)) return;
            elements.Add(new PrototypeElement(kind, name, ModelHost.Prop(o, "Description") as string, o.ObjectKey.ToString()!));
        }
        // A client action of a referenced module (OutSystemsUI's NotificationClose...): the Studio renames a screen action of that
        // name (observed 2026-10-11), so the planner reserves it for every screen and block.
        // An entity, static entity or structure of a referenced module holds its name too: the importer's entity of that name
        // gets the prototype's prefix (an Imovel of the data module and the prototype's own would read the same in expressions).
        void AddReferenced(IObjectSignature o)
        {
            var kind = new[] { "IClientActionSignature", "IServerEntitySignature", "IStaticEntitySignature", "IStructureSignature" }.FirstOrDefault(k => Implements(o, k));
            if (kind == null || TypeResolver.Name(o) is not { Length: > 0 } name || o.ObjectKey == null || !seen.Add(o.ObjectKey.ToString()!)) return;
            elements.Add(new PrototypeElement(kind, name, null, o.ObjectKey.ToString()!));
        }
        foreach (var child in ((IObjectSignature)_es).Children.OfType<IObjectSignature>())
        {
            if (child.Parent != null && !ReferenceEquals(child.Parent, _espace))
            {
                if (child.Parent is IObjectSignature owner && Implements(owner, "IReference")) AddReferenced(child);
                continue;
            }
            if (Implements(child, "IReference")) { foreach (var item in child.Children.OfType<IObjectSignature>()) AddReferenced(item); continue; }
            Add(child);
            if (ShortType(child) == "IMobileFlow") foreach (var node in child.Children.OfType<IObjectSignature>()) Add(node);
        }
        var name = TypeResolver.Name(_espace) ?? "Module";
        return new PrototypeModule
        {
            Name = name, Platform = MessageExpectations.Lane, Elements = elements,
            ChildrenOf = key =>
            {
                if (Resolve("@" + key) is not IObjectSignature owner) return [];
                return owner.Children.OfType<IObjectSignature>().Where(c => c.ObjectKey != null && (Implements(c, "IEntityAttribute") || Implements(c, "IRecord")))
                    .Select(c => new PrototypePrototypeChild(c)).Select(c => c.Element).ToList();
            },
        };
    }

    private sealed class PrototypePrototypeChild(IObjectSignature o)
    {
        public PrototypeElement Element { get; } = new(Implements(o, "IRecord") ? "IRecord" : "IEntityAttribute",
            (Implements(o, "IRecord") ? ModelHost.Prop(o, "Identifier") as string : TypeResolver.Name(o)) ?? "", null, o.ObjectKey!.ToString()!);
    }

    /// <summary>A marked screen or block before it is imported again (1.6): its widgets, actions, aggregates, data actions, locals,
    /// inputs and block events go (the element keeps its key); the lifecycle handlers that pointed at them are cleared.</summary>
    private void PrototypeClear(object owner, string kind)
    {
        if (owner is not IObjectSignature o) return;
        foreach (var name in LifecycleEvents)
            if (ModelHost.Prop(o, name) is IObjectSignature evt && FindProperty(evt, "Destination") is { CanWrite: true } destination) destination.SetValue(evt, null);
        var removable = o.Children.OfType<IObjectSignature>().Where(c =>
            Implements(c, "IScreenAction") || Implements(c, "IScreenAggregate") || Implements(c, "IDataAction") || Implements(c, "ILocalVariable")
            || Implements(c, "IInputParameter") || Implements(c, "IBlockEvent")
            || c is OutSystems.Model.UI.IWidget && !(kind == "screen" && Implements(c, "IMobileBlockInstanceWidget"))).ToList();
        // the screen keeps its layout instance (the shell): only the content of its placeholders goes
        if (kind == "screen")
            foreach (var instance in o.Children.OfType<IObjectSignature>().Where(c => Implements(c, "IMobileBlockInstanceWidget")))
                foreach (var placeholder in instance.Children.OfType<IObjectSignature>())
                    removable.AddRange(placeholder.Children.OfType<IObjectSignature>().Where(c => c is OutSystems.Model.UI.IWidget));
        foreach (var item in removable) if (!item.WasDeleted) item.Delete();
        _byKey = null;
    }

    /// <summary>1.6: a marked element of the previous import that the capture no longer produces goes when nothing outside the
    /// prefix references it (references from the importation's own marked elements, rebuilt by this op, do not count); otherwise
    /// it stays and is listed with its consumers.</summary>
    private (JsonArray Removed, JsonArray Kept) PrototypeVanished(PrototypePlan plan)
    {
        var removed = new JsonArray();
        var kept = new JsonArray();
        var prefix = plan.Capture.Prefix;
        foreach (var element in plan.Vanished)
        {
            IObjectSignature? target;
            try { target = Resolve("@" + element.Key) as IObjectSignature; } catch (KeyNotFoundException) { continue; }
            if (target == null || target.WasDeleted) continue;
            var outside = DeleteConsumers(target).Where(c => !PrototypeOwned(c.Referer, prefix)).Select(c => c.Path).ToList();
            var entry = new JsonObject { ["kind"] = element.Kind, ["name"] = element.Name };
            if (outside.Count > 0)
            {
                entry["consumers"] = new JsonArray(outside.Select(p => (JsonNode)p).ToArray());
                kept.Add(entry);
                continue;
            }
            Touch(target.Parent);
            EsquecerApagado(target);
            target.Delete();
            removed.Add(entry);
        }
        _byKey = null;
        return (removed, kept);
    }

    /// <summary>True when the object is inside an element marked by this prefix (a screen, block, action or entity of the import).</summary>
    private static bool PrototypeOwned(IObjectSignature referer, string prefix)
    {
        for (IObjectSignature? o = referer; o != null && o is not IESpace; o = o.Parent as IObjectSignature)
            if (PrototypeNames.IsMarked(ModelHost.Prop(o, "Description") as string, prefix)) return true;
        return false;
    }

    /// <summary>The built roots read back by the css lane's renderer (4.4 step 2) into prototype-dom.json, next to the bundle.</summary>
    private JsonNode PrototypeRender(PrototypePlan plan, PrototypeCapture capture, Dictionary<string, object> popups, IReadOnlyDictionary<string, string> keys)
    {
        var roots = new Dictionary<string, IObjectSignature>(StringComparer.Ordinal);
        if (plan.ShellName != null && plan.OwnerRefs.TryGetValue(plan.ShellName, out var shellRef) && Resolve(shellRef) is IObjectSignature shell) roots["shell"] = shell;
        foreach (var (view, screen) in plan.Screens)
            if (plan.OwnerRefs.TryGetValue(screen, out var screenRef) && Resolve(screenRef) is IObjectSignature s) roots["v:" + view] = s;
        foreach (var (key, popup) in popups) if (popup is IObjectSignature p) roots[key] = p;
        var render = PrototypeExpander.Current.Render ?? throw new KernelRefusalException(PrototypeCapture.IrInvalid, "prototype: Render missing");
        // the capture the renderer reads carries the built widget keys -> capture keys, so every rendered element names its k and
        // only the runtime's own wrappers are left without one (the fidelity measure aligns by k)
        var json = capture.Json.DeepClone().AsObject();
        json["nativeKeys"] = new JsonObject(keys.Select(k => KeyValuePair.Create(k.Key, (JsonNode?)k.Value)));
        // the records of the static entities the compiler created itself (options of the selects)
        json["nativeRows"] = plan.StaticRows.DeepClone();
        // the collection each entity holds (Imovel <- imoveis): the seed rows of an aggregate's entity
        json["nativeEntities"] = new JsonObject(plan.EntityCollections.Select(p => KeyValuePair.Create(p.Key, (JsonNode?)p.Value)));
        // data.bind (2.12): the example outputs of the Data Actions, chosen so the bound expressions render the captured texts
        if (capture.Bind != null) json["nativeSamples"] = capture.Bind.Samples.DeepClone();
        var dom = render(new PrototypeRenderRequest(json, plan.Platform, roots));
        // the selectors the rewrites changed: the measure matches the rewritten selector on the native tree (4.4 step 3 b)
        if (plan.CssReport?["selectors"] is JsonArray selectors) dom["selectors"] = selectors.DeepClone();
        var path = Path.Combine(capture.BundleRoot, "prototype-dom.json");
        File.WriteAllText(path, dom.ToJsonString());
        return new JsonObject { ["path"] = path, ["roots"] = new JsonArray(roots.Keys.Order(StringComparer.Ordinal).Select(k => (JsonNode)k).ToArray()) };
    }

    /// <summary>The defaults the installed Model API gives each widget type of <see cref="PrototypeWidgetDefaults"/>: one of each
    /// created in a screen of a new flow, read back, nothing saved.</summary>
    internal static JsonObject ObservePrototypeDefaults(ESpace espace, string platform)
    {
        var session = new ModelSession(espace);
        var result = new JsonObject();
        session.Apply(new JsonArray(
            JsonNode.Parse("""{"op":"create","parent":"@espace","type":"IMobileFlow","name":"SsamDefaultsProbe","as":"$flow"}"""),
            JsonNode.Parse("""{"op":"create","parent":"$flow","type":"IMobileScreen","name":"SsamDefaultsProbe","as":"$scr"}""")));
        var screen = session.Resolve("$scr");
        session.Mutate("prototype defaults", () =>
        {
            foreach (var type in PrototypeWidgetDefaults.Types)
            {
                object? widget = null;
                foreach (var (method, generic, target) in session.FindCreate(screen, type))
                {
                    var m = generic ? method.MakeGenericMethod(target) : method;
                    try { widget = m.Invoke(screen, m.GetParameters().Select(p => p.ParameterType == typeof(Type) ? (object)target : p.HasDefaultValue ? p.DefaultValue : null).ToArray()); }
                    catch { continue; }
                    if (widget != null) break;
                }
                if (widget is not IObjectSignature sig) continue;
                var o = new JsonObject
                {
                    ["Style"] = (PrototypeBuilder.Prop(widget, "Style") as IExpression)?.Text,
                    ["Width"] = PrototypeBuilder.Prop(widget, "Width") as string,
                    ["MarginLeft"] = PrototypeBuilder.Prop(widget, "MarginLeft") as string,
                    ["Children"] = new JsonArray(PrototypeWidgetDefaults.DefaultChildren(sig).Select(c => (JsonNode)c.GetType().Name).ToArray()),
                    ["Class"] = widget.GetType().FullName,
                };
                result[type] = o;
            }
        });
        return result;
    }
}
