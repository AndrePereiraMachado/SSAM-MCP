using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;

namespace Anvil.Core.Preflight;

/// <summary>
/// R1 (2026-10-24): the root rules of the scope phase, each over what the job declares (<see cref="ScopeJob"/>) and the base
/// as a fresh module index (<see cref="IndexBaseFacts"/>). A rule reports only what it can prove: a name the index and the job
/// do not settle (a producer imported by key, a generator op) is left to the apply. Every problem: phase scope, rule, the code
/// the apply or the Verify would have answered (predicts), op, pointer, message, fix with up to five candidates, and a patch
/// when one correction is certain.
/// <list type="bullet">
/// <item>CALL_UNKNOWN: an action a logic op calls or navigates to (the JSON form's calls, the ssam-flow/1 texts' calls,
/// navigates and event destinations) that is not of the module, of a module it references, of the job or of the System.</item>
/// <item>OWNER_CHILD_EXISTS: a child by position (`$link/#ITextWidget`) that a widget the job creates is never born with
/// and no op creates before.</item>
/// <item>ACTION_KIND_NODE: a widget of the other family (a Traditional ContainerWidget in a Reactive module) or a child the
/// platform refuses under its parent (a Container in an Email).</item>
/// <item>WIDGET_REQUIRED_PROPERTY: a Link or Button the job creates whose destination no op writes; an &lt;a href&gt; of a
/// document without onclick (the Link of the Studio has no URL destination).</item>
/// </list>
/// </summary>
internal static class ScopeRules
{
    public const string CallUnknown = "CALL_UNKNOWN";
    public const string ChildExists = "OWNER_CHILD_EXISTS";
    public const string KindNode = "ACTION_KIND_NODE";
    public const string Required = "WIDGET_REQUIRED_PROPERTY";
    public const string Vocabulary = "WIDGET_PROPERTY_VOCABULARY";
    public const string UnknownIdentifier = "SCOPE_UNKNOWN_IDENTIFIER";

    internal static JsonObject Problem(int op, string? pointer, string code, string predicts, string message, string fix, JsonArray? patch, string kind)
    {
        var problem = JobPreflight.Problem(op, pointer, code, "error", message, fix, patch, kind);
        problem["phase"] = ScopePhase.Phase;
        problem["rule"] = code;
        problem["predicts"] = predicts;
        return problem;
    }

    // ---- CALL_UNKNOWN -----------------------------------------------------------------------------------------------------

    private static readonly Regex EntityAction = new(@"^(?:CreateOrUpdate|Create|Update|Delete|Get)(\w+?)(?:ForUpdate)?$", RegexOptions.Compiled);

    /// <summary>What the base and the job know of the actions, screens and producers a call may name.</summary>
    internal sealed class Callables
    {
        public string? Module;
        public readonly Dictionary<string, HashSet<string>> Producers = new(StringComparer.OrdinalIgnoreCase);
        /// <summary>Producers whose names are not all known here (an element imported by key, a clipped digest list).</summary>
        public readonly HashSet<string> Open = new(StringComparer.OrdinalIgnoreCase);
        public IndexBaseFacts Index = null!;
        public ScopeJob Job = null!;
        public IReadOnlyDictionary<string, BuiltinFact>? Builtins;
        /// <summary>The destinations of the System a navigate reaches with no reference of the module (RedirectToURL, both lanes).</summary>
        public IReadOnlySet<string> SystemDestinations = new HashSet<string>();

        public bool JobDeclares(string name) => Job.Ops.Any(o => o.Declares.Contains(name));

        public IEnumerable<string> ProducerNames(string producer) => Producers.TryGetValue(producer, out var names) ? names : [];

        public bool IsProducer(string name) => Producers.ContainsKey(name) || Open.Contains(name);

        /// <summary>The actions of a screen or block of the base (screen actions, data actions), or null when it has none.</summary>
        public IReadOnlyCollection<string>? OwnerActions(string owner)
        {
            foreach (var block in new[] { false, true })
                if (Index.Root(owner, block) is { } root)
                    return root.Children.Where(c => c.Key.Contains("Action", StringComparison.Ordinal) || c.Key.Contains("Preparation", StringComparison.Ordinal)).SelectMany(c => c.Value).ToHashSet(StringComparer.OrdinalIgnoreCase);
            return null;
        }

        public bool IsOwner(string name) => Job.Roots.ContainsKey(name) || Index.Root(name, false) != null || Index.Root(name, true) != null
            || Index.KindsOf(name).Any(k => IndexBaseFacts.ScreenKind.IsMatch(k) || IndexBaseFacts.BlockKind.IsMatch(k));

        public bool ModuleHas(string name) => Index.KindsOf(name).Any(k => k.Contains("Action", StringComparison.Ordinal) || IndexBaseFacts.ScreenKind.IsMatch(k)
            || IndexBaseFacts.BlockKind.IsMatch(k)) || Index.IsFunction(name);

        public bool IsRecord(string name) => Index.KindsOf(name).Any(k => k.Contains("Entity", StringComparison.Ordinal) || k.Contains("Structure", StringComparison.Ordinal)) || JobDeclares(name);
    }

    internal static Callables Known(IndexBaseFacts index, ScopeJob job, JsonArray ops, string lane)
    {
        var known = new Callables { Module = index.Basis.Module?.ModuleName, Index = index, Job = job, Builtins = Builtins.For(lane) };
        // Both lanes bind navigate RedirectToURL to the System's destination with no reference of the module (ODC: labs 228
        // and 242; O11 Reactive: SecurityNativeMessageTests, the open-redirect proof of the candidate): never CALL_UNKNOWN.
        known.SystemDestinations = PreflightRules.OdcScopeRules.SystemDestinations;
        void Add(string producer, string name)
        {
            if (!known.Producers.TryGetValue(producer, out var set)) known.Producers[producer] = set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            set.Add(name);
        }
        if (index.Basis.Digest is { } digest)
        {
            foreach (var (producer, _, name) in IndexBaseFacts.DigestReferences(digest)) Add(producer, name);
            // A reference block whose lists the digest clipped (…) does not list every name.
            foreach (var section in (digest["sections"] as JsonArray ?? []).OfType<JsonObject>().Where(s => s["id"]?.ToString() == "module"))
                foreach (var block in (section["blocks"] as JsonArray ?? []).OfType<JsonObject>().Where(b => b["kind"]?.ToString() == "Reference"))
                    if ((block["text"]?.ToString() ?? "").Contains('…') && Regex.Match(block["text"]!.ToString(), @"^reference\s+(.+?)\s+@") is { Success: true } head)
                        known.Open.Add(head.Groups[1].Value.Trim());
        }
        // The references of the index (rows of role reference and what is under them).
        if (index.Basis.Module is { } module)
        {
            var rows = module.Rows().ToList();
            foreach (var reference in rows.Where(r => r.Role == "reference" && r.Name.Length > 0))
                foreach (var row in rows.Where(r => r.Parent == reference.Index && r.Name.Length > 0)) Add(reference.Name, row.Name);
        }
        foreach (var op in ops.OfType<JsonObject>().Where(o => o["op"]?.ToString() == "reference"))
        {
            var producer = ScopeJob.ProducerName(op["producer"]?.ToString() ?? "");
            if (producer.Length == 0) continue;
            if (!known.Producers.ContainsKey(producer)) known.Producers[producer] = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var element in (op["elements"] as JsonArray ?? []).Select(e => e?.ToString() ?? ""))
            {
                var name = element[(element.IndexOf(':') + 1)..].Trim();
                if (name.StartsWith('@') || name.Length == 0) known.Open.Add(producer);
                else Add(producer, name);
            }
        }
        return known;
    }

    /// <summary>Null when the callee resolves (or cannot be judged); else why not and the candidates.</summary>
    internal static (string Why, List<string> Candidates)? Resolve(string callee, string? owner, Callables k, bool screen = false)
    {
        callee = callee.Trim();
        if (callee.Length == 0 || callee.StartsWith('$') || callee.StartsWith('@') || callee.StartsWith("(System)", StringComparison.Ordinal)) return null;
        // A key (`IServerActionSignature:@key/@key` of a frozen or imported producer) is the apply's to resolve.
        if (callee.Contains('@')) return null;
        if (callee.Contains(':'))
        {
            // The reference form: `Kind:Name` or `Kind:Owner/Kind:Name` (a screen action of an owner, read as Owner.Name).
            var names = callee.Split('/').Select(s => s[(s.IndexOf(':') + 1)..]).ToList();
            var first = callee.Split('/')[0];
            var flow = first.Contains("Flow:", StringComparison.Ordinal);
            callee = names.Count == 2 && !flow ? names[0] + "." + names[1] : names.Count >= 2 && flow ? "/" + names[^1] : names[^1];
        }
        if (screen && !callee.Contains('.') && !callee.Contains('/')) callee = "/" + callee;
        if (callee.Contains('/'))
        {
            // Flow/Screen (a navigate): the screen.
            var target = callee.Split('/').Last();
            if (k.IsOwner(target) || k.JobDeclares(target) || k.ModuleHas(target) || k.SystemDestinations.Contains(target)) return null;
            return ($"no screen of the module or of this job is named '{target}'", Candidates(target, k.Index.Roots("screen").Concat(k.Job.Roots.Keys)));
        }
        var dot = callee.IndexOf('.');
        if (dot > 0)
        {
            var qualifier = callee[..dot]; var name = callee[(dot + 1)..];
            if (name.Contains('.')) return null;
            if (string.Equals(qualifier, "System", StringComparison.OrdinalIgnoreCase)) return null;
            if (string.Equals(qualifier, k.Module, StringComparison.OrdinalIgnoreCase)) return Resolve(name, owner, k);
            if (k.JobDeclares(callee)) return null;
            if (k.IsOwner(qualifier))
            {
                var actions = k.OwnerActions(qualifier);
                if (actions == null || actions.Contains(name)) return null;
                var mine = k.Job.Ops.SelectMany(o => o.Declares).Where(d => d.StartsWith(qualifier + ".", StringComparison.OrdinalIgnoreCase)).Select(d => d[(qualifier.Length + 1)..]);
                return ($"'{qualifier}' has no screen action or data action '{name}', and no logic op of this job declares {qualifier}.{name}", Candidates(name, actions.Concat(mine)));
            }
            if (k.Open.Contains(qualifier)) return null;
            if (k.Producers.TryGetValue(qualifier, out var names))
                return names.Contains(name) ? null
                    : ($"'{name}' is not an element of {qualifier} that this module references or that a reference op of this job imports", Candidates(name, names));
            // A qualifier that is no module, owner or producer of the base or of the job.
            if (k.Index.TopLevel(qualifier)) return null;
            return ($"'{qualifier}' is no module this module references, no reference op of this job imports it, and no screen or block is named so",
                Candidates(qualifier, k.Producers.Keys.Concat(k.Index.Roots("screen")).Concat(k.Index.Roots("block"))));
        }
        // Bare: an action of the owner, of the module, of the job, an entity action, a built-in, a screen.
        if (k.JobDeclares(callee) || owner != null && k.JobDeclares(owner + "." + callee)) return null;
        if (owner != null && k.OwnerActions(owner)?.Contains(callee) == true) return null;
        if (k.ModuleHas(callee) || k.IsOwner(callee) || k.Builtins?.ContainsKey(callee) == true || SystemCalls.Inputs.ContainsKey(callee)) return null;
        if (EntityAction.Match(callee) is { Success: true } entity && k.IsRecord(entity.Groups[1].Value)) return null;
        // A producer element written without its qualifier, of one producer only: the qualifier it means.
        var owners = k.Producers.Where(p => p.Value.Contains(callee)).Select(p => p.Key).ToList();
        if (owners.Count >= 1) return null;
        if (k.Open.Count > 0 || k.Job.Generators) return null;
        var pool = k.Index.NamesOf(kind => kind.Contains("Action", StringComparison.Ordinal)).Concat(k.Job.Ops.SelectMany(o => o.Declares).Where(d => !d.StartsWith('$')))
            .Concat(owner != null ? k.OwnerActions(owner) ?? [] : []);
        return ($"no action of the module, of its references or of this job is named '{callee}'", Candidates(callee, pool));
    }

    internal static List<string> Candidates(string name, IEnumerable<string> pool)
    {
        var distinct = pool.Where(p => p.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        return NameSuggestions.Closest(name, distinct, 5).ToList();
    }

    public static IEnumerable<JsonObject> Calls(JsonArray ops, string? prefix, ScopeJob job, Callables known)
    {
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "logic" || op["data"] is not JsonObject data) continue;
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var actions = data["actions"] as JsonArray ?? [];
            for (var a = 0; a < actions.Count; a++)
            {
                if (actions[a] is not JsonObject action) continue;
                var owner = ScopeJob.OwnerName(JobFacts.Owner(action));
                foreach (var call in LogicScan.Of(action).Calls)
                {
                    if (Resolve(call.Target, owner, known) is not { } why || !seen.Add(call.Target)) continue;
                    var at = prefix == null ? null : $"{prefix}/{i}/data/actions/{a}{call.Pointer}";
                    yield return CallProblem(i, at, call.Target, why, at == null ? null : at + "/call", call.Target, "LOGIC_INVALID");
                }
            }
            var flow = data["flow"] ?? data["text"];
            foreach (var (index, text) in DocumentNameRules.Texts(data))
            {
                FlowItem parsed;
                try { parsed = FlowParser.Parse(text); } catch { continue; }   // a text the grammar refuses is the preflight's
                var owner = parsed.Owner.Length > 0 ? parsed.Owner.Split('/').Last() : null;
                var at = prefix == null ? null : $"{prefix}/{i}/" + (flow is JsonArray ? $"{(data["flow"] != null ? "data/flow" : "data/text")}/{index}" : data["flow"] != null ? "data/flow" : "data/text");
                foreach (var (callee, screen) in Callees(parsed))
                {
                    if (Resolve(callee, owner, known, screen) is not { } why || !seen.Add(callee)) continue;
                    var problem = CallProblem(i, at, callee, why, null, null, "FLOW_NAME_UNKNOWN");
                    // The certain correction (one candidate the name can mean), written in the text of the action.
                    if (at != null && Meant(callee, why.Candidates) is { } meant)
                        problem["patch"] = new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = at, ["value"] = Regex.Replace(text, @"(?<![\w.])" + Regex.Escape(callee) + @"(?=\s*\()", Qualified(callee, meant)) });
                    yield return problem;
                }
            }
        }
    }

    private static string Last(string name) => name.Split('.', '/').Last();

    /// <summary>The one candidate a name can mean (NameSuggestions.OnlyMatch over their last segments), or null.</summary>
    /// <summary>Two neighbouring letters swapped (Fitler for Filter): the commonest typo, two edits apart.</summary>
    private static bool Transposed(string a, string b)
    {
        if (a.Length != b.Length || a.Length < 3) return false;
        var diff = Enumerable.Range(0, a.Length).Where(i => char.ToUpperInvariant(a[i]) != char.ToUpperInvariant(b[i])).ToList();
        return diff.Count == 2 && diff[1] == diff[0] + 1 && char.ToUpperInvariant(a[diff[0]]) == char.ToUpperInvariant(b[diff[1]]) && char.ToUpperInvariant(a[diff[1]]) == char.ToUpperInvariant(b[diff[0]]);
    }

    internal static string? Meant(string callee, IReadOnlyList<string> candidates)
    {
        var name = Last(callee);
        var close = candidates.Where(c => Last(c) is var last && (last.Contains(name, StringComparison.OrdinalIgnoreCase) || name.Contains(last, StringComparison.OrdinalIgnoreCase)
            || NameSuggestions.Distance(name.ToUpperInvariant(), last.ToUpperInvariant()) <= Math.Max(1, Math.Min(name.Length, last.Length) / 4)
            || Transposed(name, last)))
            .DistinctBy(Last, StringComparer.OrdinalIgnoreCase).ToList();
        return close.Count == 1 ? close[0] : null;
    }
    private static string Qualified(string written, string candidate) => written.Contains('.') ? written[..(written.LastIndexOf('.') + 1)] + Last(candidate) : Last(candidate);

    private static JsonObject CallProblem(int op, string? pointer, string callee, (string Why, List<string> Candidates) why, string? patchPath, string? written, string predicts)
    {
        var meant = Meant(callee, why.Candidates);
        var patch = patchPath != null && written != null && meant != null
            ? new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = patchPath, ["value"] = Qualified(written, meant) }) : null;
        return Problem(op, pointer, CallUnknown, predicts, $"the call {callee}(...): {why.Why}",
            why.Candidates.Count > 0 ? $"call one of: {string.Join(", ", why.Candidates)}; or declare it earlier in this job (a logic op), or import it (a reference op)"
                : "declare the action in a logic op of this job, import it with a reference op, or name an action of the module (ssam_map)", patch, "logic");
    }

    /// <summary>Every callee of a parsed action: the calls, the navigates and the event destinations.</summary>
    private static IEnumerable<(string Callee, bool Screen)> Callees(FlowItem item)
    {
        if (item.Role is "node" or "event")
        {
            if (item.Kind == "Execute" && item.Prop("Action") is { Length: > 0 } action) yield return (action, false);
            if (item.Prop("Destination") is { Length: > 0 } destination) yield return (destination, item.Kind == "DestinationNode");
        }
        foreach (var child in item.Items)
            foreach (var callee in Callees(child)) yield return callee;
    }

    // ---- ACTION_KIND_NODE -------------------------------------------------------------------------------------------------

    /// <summary>What the platform refuses to create, by module type, read from the creation maps of the fixtures
    /// (kernel/docs/mapa/criar-&lt;fixture&gt;.json, ProofGenerator: every creatable type under every parent, by the Studio):
    /// the types with no class in that module type (every probe "Couldn't find any concrete class", none created) and the
    /// (type, parent) pairs refused as children (none of that pair created).</summary>
    internal sealed record WhereCan(string Fixture, IReadOnlySet<string> NoClass, IReadOnlyDictionary<(string Type, string Parent), string> NotChild, IReadOnlySet<string> Creatable);

    private static readonly Dictionary<string, WhereCan?> Maps = new(StringComparer.Ordinal);

    internal static WhereCan? MapFor(string? moduleType)
    {
        var fixture = moduleType switch
        {
            "CrossDevice" or "ReactiveLibrary" => "reactive-ui",
            "Mobile" or "MobileLibrary" => "mobile-ui",
            "WebResponsive" or "WebResponsiveLibrary" => "traditional-ui",
            _ => null,
        };
        if (fixture == null) return null;
        lock (Maps)
        {
            if (Maps.TryGetValue(fixture, out var known)) return known;
            WhereCan? map = null;
            try
            {
                var file = JobSources.KernelRoot() is { } root ? Path.Combine(root, "docs", "mapa", "criar-" + fixture + ".json") : null;
                if (file != null && File.Exists(file) && JsonNode.Parse(File.ReadAllText(file))?["rows"] is JsonArray rows)
                {
                    var byType = rows.OfType<JsonObject>().GroupBy(r => r["Type"]?.ToString() ?? "").ToDictionary(g => g.Key, g => g.ToList(), StringComparer.Ordinal);
                    static bool Made(JsonObject r) => r["Status"]?.ToString() is "created" or "created-needs-config" or "created-with-messages";
                    var noClass = byType.Where(g => g.Value.Any(r => (r["Error"]?.ToString() ?? "").Contains("Couldn't find any concrete class", StringComparison.Ordinal))
                        && !g.Value.Any(Made)).Select(g => g.Key).ToHashSet(StringComparer.Ordinal);
                    var notChild = new Dictionary<(string, string), string>();
                    foreach (var r in rows.OfType<JsonObject>())
                    {
                        var error = r["Error"]?.ToString() ?? "";
                        if (r["Status"]?.ToString() != "not-allowed" || !error.Contains("can't be children of", StringComparison.Ordinal)) continue;
                        var key = (r["Type"]?.ToString() ?? "", r["Parent"]?.ToString() ?? "");
                        if (byType[key.Item1].Any(o => o["Parent"]?.ToString() == key.Item2 && Made(o))) continue;
                        notChild.TryAdd(key, error[(error.IndexOf(": ", StringComparison.Ordinal) + 2)..]);
                    }
                    var creatable = byType.Where(g => g.Value.Any(Made)).Select(g => g.Key).ToHashSet(StringComparer.Ordinal);
                    map = new WhereCan(fixture, noClass, notChild, creatable);
                }
            }
            catch { map = null; }
            Maps[fixture] = map;
            return map;
        }
    }

    /// <summary>The type of the same family a type with no class in this module type means: the Traditional widget without
    /// its Widget suffix in a Reactive or Mobile module (IContainerWidget is IContainer), with it in a Traditional one.</summary>
    private static string? Counterpart(string type, WhereCan map)
    {
        var other = type.EndsWith("Widget", StringComparison.Ordinal) ? type[..^"Widget".Length] : type + "Widget";
        return map.Creatable.Contains(other) && !map.NoClass.Contains(other) ? other : null;
    }

    public static IEnumerable<JsonObject> Kinds(JsonArray ops, string? prefix, ScopeJob job, string? moduleType, string lane = "o11")
    {
        // The maps are the O11 Studio's (its fixtures): an ODC module (its widgets, a placeholder of a block under a container
        // of that block) is not judged by them.
        if (lane != "o11" || MapFor(moduleType) is not { } map) yield break;
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "create") continue;
            var type = KindNames.Normalize(op["type"]?.ToString() ?? "");
            var at = prefix == null ? null : $"{prefix}/{i}/type";
            if (map.NoClass.Contains(type))
            {
                var other = Counterpart(type, map);
                yield return Problem(i, at, KindNode, "APPLY_FAILED", $"{type} has no class in a {moduleType} module (the Studio creates it only in another kind of module)",
                    other != null ? $"write {other}, the same widget of this module's kind" : "create the widget of this module's kind (ssam_map lists the widgets of a screen of this module)",
                    other != null && at != null ? new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = at, ["value"] = other }) : null, "create");
                continue;
            }
            var parentType = ParentType(op["parent"]?.ToString(), job, i);
            if (parentType != null && map.NotChild.TryGetValue((type, parentType), out var refusal))
                yield return Problem(i, prefix == null ? null : $"{prefix}/{i}/parent", KindNode, "APPLY_FAILED", $"{type} under a {parentType}: {refusal}",
                    $"create the {type} under a container the {parentType} holds, or use a widget a {parentType} accepts", null, "create");
        }
    }

    /// <summary>The type of the element a parent reference names: an alias the job created, or the `Kind:Name` it ends with.</summary>
    private static string? ParentType(string? parent, ScopeJob job, int op)
    {
        if (string.IsNullOrEmpty(parent)) return null;
        if (parent.StartsWith('$') && !parent.Contains('/')) return job.AliasAt.TryGetValue(op, out var e) ? e.Type : null;
        var last = parent.Split('/').Last();
        var colon = last.IndexOf(':');
        return colon > 0 && !parent.Contains('$') ? KindNames.Normalize(last[..colon]) : null;
    }

    // ---- WIDGET_REQUIRED_PROPERTY -----------------------------------------------------------------------------------------

    /// <summary>The widgets the Verify refuses without a destination (RequiredPropertyValue: On Click / Destination must be
    /// set): every accepted raw job of 11-24/10/2026 writes it on `$x/OnClick`.</summary>
    private static readonly HashSet<string> NeedsDestination = new(StringComparer.Ordinal) { "IButton", "ILink", "IButtonWidget", "ILinkWidget" };

    public static IEnumerable<JsonObject> Destinations(JsonArray ops, string? prefix, ScopeJob job)
    {
        // An op this reader cannot follow may write the event (a generator, an html op over the same element): no evidence.
        if (job.Generators) yield break;
        var written = new HashSet<string>(StringComparer.Ordinal);
        foreach (var o in ops.OfType<JsonObject>())
            foreach (var key in new[] { "target", "parent", "from", "to" })
                if (o[key]?.ToString() is { } reference && reference.StartsWith('$'))
                {
                    var segments = reference.Split('/');
                    if (segments.Length > 1 && segments[1] is "OnClick" or "LinkOnClick" or "ButtonOnClick" or "#IUILifeCycleEvent"
                        || o["prop"]?.ToString() is "Destination" or "OnClick" or "Handler")
                        written.Add(segments[0]);
                }
        foreach (var element in job.Elements)
        {
            var alias = element.Alias!;
            if (!NeedsDestination.Contains(element.Type) || written.Contains(alias) || job.Reused.Contains(alias)) continue;
            yield return Problem(element.Op, prefix == null ? null : $"{prefix}/{element.Op}", Required, "RequiredPropertyValue_Property",
                $"{element.Type} {alias} is created and no op writes its destination (the Verify answers 'On Click must be set')",
                $"write it after the create: {{\"op\":\"set\",\"target\":\"{alias}/OnClick\",\"prop\":\"Destination\",\"value\":\"<IMobileScreen:Screen or Owner/IScreenAction:Action>\"}}", null, "create");
        }
    }

    // ---- WIDGET_PROPERTY_VOCABULARY ---------------------------------------------------------------------------------------

    /// <summary>A raw `set` on an element the job creates, of a property an element of the same type in the base has no way to
    /// write (the apply's PROPERTY_NOT_WRITABLE), with the writable names; the patch when one of them contains the name.</summary>
    public static IEnumerable<JsonObject> Properties(JsonArray ops, string? prefix, ScopeJob job, IBaseFacts facts, string lane = "o11")
    {
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "set" || op["target"]?.ToString() is not { } target || op["prop"]?.ToString() is not { Length: > 0 } prop) continue;
            if (target.Contains('/') || !job.AliasAt.TryGetValue(i, out var element) || element.Type.Length == 0) continue;
            // A name the Model API knows on any interface of that short name (IExpression is the expression and the Expression
            // widget) may be what the apply writes: only a name no interface of it has is judged by the element of the base.
            if (facts.Settable(element.Type, prop) is not { CanSet: false } fact || ModelTypes.Of(element.Type, lane)?.Knows(prop) == true) continue;
            var at = prefix == null ? null : $"{prefix}/{i}/prop";
            var meant = fact.Writable.Where(w => w.Contains(prop, StringComparison.OrdinalIgnoreCase) || prop.Contains(w, StringComparison.OrdinalIgnoreCase)).ToList() is [var only] ? only : null;
            yield return Problem(i, at, Vocabulary, "PROPERTY_NOT_WRITABLE", $"{element.Type} {target}: {fact.Refusal}",
                fact.Writable.Count > 0 ? $"write one of: {string.Join(", ", fact.Writable.Take(5))}" : "remove this set: the element has no such property",
                meant != null && at != null ? new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = at, ["value"] = meant }) : null, "set");
        }
    }

    // ---- SCOPE_UNKNOWN_IDENTIFIER -----------------------------------------------------------------------------------------

    /// <summary>The properties whose value is an expression of the owner's scope (the event arguments and block inputs write
    /// Value); a literal text (Text, Name, Label...) and the per-element expressions of a list (Labels, Values) are not read.</summary>
    private static readonly HashSet<string> ScopedProperties = new(StringComparer.Ordinal) { "Value", "Variable", "Visible", "Enabled", "Condition", "Source", "SourceRecord", "List", "Style" };

    private static readonly HashSet<string> ScopeGlobals = new(StringComparer.OrdinalIgnoreCase)
        { "True", "False", "and", "or", "not", "like", "Entities", "Site", "Session", "Roles", "Resources", "Settings", "Request", "Client", "BuiltinClientVariables", "Images", "Themes", "NullObject", "NullTextIdentifier" };

    /// <summary>The roots of the expressions a raw `set` writes on an element the job creates inside a screen or block:
    /// each is a name of that owner (an input, a variable, an aggregate, a data action or a widget of the base's owner, or
    /// one the job declares under it), a global of the language or a module the job reaches by name. Anything else is
    /// the Verify's ExpressionUnknownObject; a name of a record is a type, not a value. Not judged: an owner the base and the
    /// job do not settle (a screen generator, an html op that writes it with names this reader does not list).</summary>
    public static IEnumerable<JsonObject> Identifiers(JsonArray ops, string? prefix, ScopeJob job, IndexBaseFacts index, Callables known)
    {
        if (job.Generators) yield break;
        // The owners an html op writes into: their names come from its compile, not from this reader.
        var written = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < ops.Count; i++)
            if (ops[i] is JsonObject op && op["op"]?.ToString() == "html" && job.OwnerOf(op["parent"]?.ToString()).Owner is { } owner) written.Add(owner);
        var declared = job.Ops.SelectMany(o => o.Declares).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "set" || op["target"]?.ToString() is not { } target || !target.StartsWith('$')) continue;
            if (op["prop"]?.ToString() is not { } prop || !ScopedProperties.Contains(prop) || op["value"] is not JsonValue v || !v.TryGetValue<string>(out var value)) continue;
            if (job.OwnerAt.GetValueOrDefault(i) is not { Owner: { } owner } holder || written.Contains(owner) || InLogic(i, job)) continue;
            // The arguments of an event (`$block/Initialized/AccordionId`, `$tabs/OnTabChange/ActiveTab`) read the event's own
            // parameters, which this reader does not list: only the click of a native Button or Link (no parameters) is read.
            var path = target.Split('/');
            if (path.Length > 2 && !(path.Length == 3 && path[1] is "OnClick" or "LinkOnClick" or "ButtonOnClick"
                && job.AliasAt.TryGetValue(i, out var clicked) && NeedsDestination.Contains(clicked.Type))) continue;
            var kind = holder.Kind ?? "screen";
            // The base's owner (all the names it holds) or the job's own: either must be readable.
            var baseNames = OwnerNames(index, owner);
            if (baseNames == null && !job.Roots.ContainsKey(owner)) continue;
            if (ExpressionSyntax.Check(value) != null) continue;
            foreach (var root in ScopeJob.RootNames(value))
            {
                if (ScopeGlobals.Contains(root) || baseNames?.Contains(root) == true || declared.Contains(owner + "." + root)
                    || known.IsProducer(root) || index.TopLevel(root) || string.Equals(root, known.Module, StringComparison.OrdinalIgnoreCase)) continue;
                if (!seen.Add(i + "|" + root)) continue;
                var type = index.NamesOnlyTypes(root);
                var pool = (baseNames ?? []).Concat(declared.Where(d => d.StartsWith(owner + ".", StringComparison.OrdinalIgnoreCase)).Select(d => d[(owner.Length + 1)..]));
                var candidates = Candidates(root, pool);
                var meant = !type ? Meant(root, candidates) : null;
                var at = prefix == null ? null : $"{prefix}/{i}/value";
                yield return Problem(i, at, UnknownIdentifier, "ExpressionUnknownObject",
                    type ? $"can't identify '{root}' in {value}: {root} is an entity or structure, a type and not a value of its {kind} {owner}"
                         : $"can't identify '{root}' in {value}: it is no input, variable, aggregate, data action or widget of its {kind} {owner}, and nothing of the module is read by that name",
                    candidates.Count > 0 ? $"use a name of its {kind} ({string.Join(", ", candidates)}), declare '{root}' in {owner} earlier in this job, or qualify it (Site., Entities., Client.)"
                        : $"declare '{root}' in its {kind} {owner} earlier in this job, or qualify it (Site., Entities., Client.)",
                    meant != null && at != null ? new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = at, ["value"] = RenameRoot(value, root, meant) }) : null, "set");
            }
        }
    }

    /// <summary>Whether a target is inside an action, a node or an assignment (its scope is the action's, not the owner's).</summary>
    private static bool InLogic(int op, ScopeJob job)
    {
        static bool Logic(string type) => type.EndsWith("Action", StringComparison.Ordinal) || type.EndsWith("Node", StringComparison.Ordinal)
            || type.Contains("Aggregate", StringComparison.Ordinal) || type.Contains("Source", StringComparison.Ordinal)
            || type is "IAssignment" or "IParameter" or "IFilter" or "ISort" or "IJoin" or "IGroupBy" or "ICalculatedAttribute" or "IPreparation";
        for (var e = job.AliasAt.GetValueOrDefault(op); e != null; e = e.Parent)
        {
            if (Logic(e.Type)) return true;
            if (e.Parent == null && e.ParentRef != null && e.ParentRef.Split('/').Any(s => s.IndexOf(':') is > 0 and var c && Logic(KindNames.Normalize(s[..c])))) return true;
        }
        return false;
    }

    /// <summary>Every name under a screen or block of the base (its data, its actions, its widgets), or null when the base has
    /// no screen or block of that name.</summary>
    private static HashSet<string>? OwnerNames(IndexBaseFacts index, string owner)
    {
        if (index.Basis.Module is not { } module) return null;
        var rows = module.Rows().ToList();
        var root = rows.FirstOrDefault(r => r.Role is "screen" or "block" && string.Equals(r.Name, owner, StringComparison.OrdinalIgnoreCase));
        if (root == null) return null;
        var children = rows.Where(r => r.Parent >= 0).GroupBy(r => r.Parent).ToDictionary(g => g.Key, g => g.ToList());
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var pending = new Stack<int>([root.Index]);
        while (pending.Count > 0)
            foreach (var row in children.GetValueOrDefault(pending.Pop()) ?? [])
            {
                if (row.Name.Length > 0) names.Add(row.Name);
                pending.Push(row.Index);
            }
        return names;
    }

    /// <summary>The expression with its root <paramref name="root"/> written <paramref name="to"/> (outside text literals).</summary>
    private static string RenameRoot(string expression, string root, string to)
        => string.Concat(Regex.Split(expression, "(\"(?:[^\"]|\"\")*\")").Select((part, n) => n % 2 == 1 ? part
            : Regex.Replace(part, @"(?<![\w.])" + Regex.Escape(root) + @"(?![\w(])", to)));

    // ---- the elements a reference op imports ------------------------------------------------------------------------------

    public const string ProducerElementRule = "SCOPE_PRODUCER_ELEMENT";

    /// <summary>Every element a reference op names, against the producer the job binds (loaded by the job's own loader, the
    /// one the apply reads): an element the producer does not have, or does not make Public, fails the whole op at apply
    /// (APPLY_FAILED), and everything the op would import is missing after it (the cascade SCOPE_BLOCKED_BY_REFUSED_OP names).</summary>
    public static IEnumerable<JsonObject> ProducerElements(JsonArray ops, string? prefix, IBaseFacts facts)
    {
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "reference" || op["producer"]?.ToString() is not { Length: > 0 } producer) continue;
            var elements = op["elements"] as JsonArray ?? [];
            for (var n = 0; n < elements.Count; n++)
            {
                if (elements[n]?.ToString() is not { Length: > 0 } element || facts.ProducerElement(producer, element) is not { } fact) continue;
                var name = ScopeJob.ProducerName(producer);
                var at = prefix == null ? null : $"{prefix}/{i}/elements/{n}";
                if (!fact.Exists)
                {
                    var bare = element[(element.IndexOf(':') + 1)..];
                    var candidates = Candidates(bare, fact.Names);
                    var meant = Meant(bare, candidates);
                    yield return Problem(i, at, "REFERENCE_ELEMENT_UNKNOWN", "APPLY_FAILED", $"{name} has no {element}: the reference op fails whole at apply, and nothing it imports exists after it",
                        candidates.Count > 0 ? $"import one of: {string.Join(", ", candidates)}; or publish the element in {name} first" : $"publish the element in {name} first, or remove it from elements",
                        meant != null && at != null ? new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = at, ["value"] = element[..(element.IndexOf(':') + 1)] + meant }) : null, "reference")
                        .Also(p => p["rule"] = ProducerElementRule);
                }
                else if (!fact.Public)
                    yield return Problem(i, at, "REFERENCE_NOT_PUBLIC", "APPLY_FAILED", $"{element} of {name} is not Public: the reference op fails whole at apply, and nothing it imports exists after it",
                        $"expose it in {name} with \"public\": true in its spec (or set Public True), then rebuild the producer job or take a new capture and include {element} in elements; or read the value through a public server action of {name}", null, "reference")
                        .Also(p => p["rule"] = ProducerElementRule);
            }
        }
    }

    private static JsonObject Also(this JsonObject problem, Action<JsonObject> change) { change(problem); return problem; }
}
