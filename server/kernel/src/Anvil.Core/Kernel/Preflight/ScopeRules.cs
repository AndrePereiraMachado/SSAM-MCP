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
    public const string CallAmbiguous = "CALL_AMBIGUOUS";
    /// <summary>F13 (proto 4b6c3591/760bc130, the owner's six rounds of 26/10/2026): how a call of a producer's action is written,
    /// said by every fix of an unknown call (CALL_UNKNOWN here, FLOW_NAME_UNKNOWN in the apply). "(Producer.Action, (System).Action)"
    /// was read as `(Sonnet_IS).ObterPokemon`, which FLOW_PRODUCER_CALL_SYNTAX now refuses.</summary>
    public const string ProducerCallForm = "a producer's action is called as Producer.Action(args), with the producer's module name (Sonnet_IS.GetPokemon(Name=N)); "
        + "only the System module is written (System).Action(args), because its name is (System)";
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
        /// <summary>R2-A: each element of a producer once, by producer and name: its name as the producer has it and its kinds,
        /// one identity whatever source lists it (the index writes MobileScreenSignature, the digest MobileScreen, a reference
        /// op IMobileScreen: all are MobileScreenSignature, the kind of the reference's own element; "" for an element a
        /// reference op writes without its kind).</summary>
        public readonly Dictionary<string, Dictionary<string, (string Name, HashSet<string> Kinds)>> ProducerKinds = new(StringComparer.OrdinalIgnoreCase);
        /// <summary>R2-A: the module's own actions by name: the name as the module has it and the kinds (index rows of role
        /// action or actionRef outside every reference, screen and block), the candidates of tier 1 of a call.</summary>
        public readonly Dictionary<string, (string Name, HashSet<string> Kinds)> ModuleActions = new(StringComparer.OrdinalIgnoreCase);
        /// <summary>R2-A: the actions the logic ops of the job declare (ScopeJob.DeclaredActions; the apply counts the same).</summary>
        public List<(string? Owner, string Name, string Kind)> Declared = [];
        /// <summary>The names of the module's own elements of any kind (not a reference's): what a call may still name that only
        /// the apply judges (a screen, a block).</summary>
        public readonly HashSet<string> Local = new(StringComparer.OrdinalIgnoreCase);
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

    /// <summary>R2-A: the kind of an element of a producer as the reference holds it: without namespace and I prefix, and with
    /// the Signature suffix the digest leaves out (MobileScreen, IMobileScreen and MobileScreenSignature are one kind).</summary>
    internal static string ProducerKind(string kind)
    {
        var bare = NameResolution.Bare(kind);
        return bare.Length == 0 || bare.EndsWith("Signature", StringComparison.Ordinal) ? bare : bare + "Signature";
    }

    internal static Callables Known(IndexBaseFacts index, ScopeJob job, JsonArray ops, string lane)
    {
        var known = new Callables { Module = index.Basis.Module?.ModuleName, Index = index, Job = job, Builtins = Builtins.For(lane), Declared = ScopeJob.DeclaredActions(ops) };
        // Both lanes bind navigate RedirectToURL to the System's destination with no reference of the module (ODC: labs 228
        // and 242; O11 Reactive: SecurityNativeMessageTests, the open-redirect proof of the candidate): never CALL_UNKNOWN.
        known.SystemDestinations = PreflightRules.OdcScopeRules.SystemDestinations;
        void Add(string producer, string name, string? kind = null)
        {
            if (!known.Producers.TryGetValue(producer, out var set)) known.Producers[producer] = set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            set.Add(name);
            if (kind == null) return;
            if (!known.ProducerKinds.TryGetValue(producer, out var byName)) known.ProducerKinds[producer] = byName = new(StringComparer.OrdinalIgnoreCase);
            if (!byName.TryGetValue(name, out var element)) byName[name] = element = (name, new HashSet<string>(StringComparer.Ordinal));
            element.Kinds.Add(ProducerKind(kind));
        }
        void Own(string name, string kind)
        {
            if (!known.ModuleActions.TryGetValue(name, out var element)) known.ModuleActions[name] = element = (name, new HashSet<string>(StringComparer.Ordinal));
            element.Kinds.Add(NameResolution.Bare(kind));
        }
        // The index first: its rows have the names and kinds as the module holds them (the digest and a reference op may write
        // them otherwise); an element another source lists again is the same one.
        if (index.Basis.Module is { } module)
        {
            var rows = module.Rows().ToList();
            foreach (var reference in rows.Where(r => r.Role == "reference" && r.Name.Length > 0))
                foreach (var row in rows.Where(r => r.Parent == reference.Index && r.Name.Length > 0)) Add(reference.Name, row.Name, reference.Kind == "Reference" ? row.Kind : null);
            foreach (var row in rows.Where(r => r.Name.Length > 0))
            {
                var holder = Holder(rows, row);
                if (holder == "reference") continue;
                if (row.Kind.Contains("Action", StringComparison.Ordinal) || IndexBaseFacts.ScreenKind.IsMatch(row.Kind) || IndexBaseFacts.BlockKind.IsMatch(row.Kind)) known.Local.Add(row.Name);
                if (holder == null && row.Role is "action" or "actionRef") Own(row.Name, row.Kind);
            }
        }
        if (index.Basis.Digest is { } digest)
        {
            foreach (var (producer, kind, name) in IndexBaseFacts.DigestReferences(digest)) Add(producer, name, kind);
            // A reference block whose lists the digest clipped (…) does not list every name.
            foreach (var section in (digest["sections"] as JsonArray ?? []).OfType<JsonObject>().Where(s => s["id"]?.ToString() == "module"))
                foreach (var block in (section["blocks"] as JsonArray ?? []).OfType<JsonObject>().Where(b => b["kind"]?.ToString() == "Reference"))
                    if ((block["text"]?.ToString() ?? "").Contains('…') && Regex.Match(block["text"]!.ToString(), @"^reference\s+(.+?)\s+@") is { Success: true } head)
                        known.Open.Add(head.Groups[1].Value.Trim());
        }
        foreach (var op in ops.OfType<JsonObject>().Where(o => o["op"]?.ToString() == "reference"))
        {
            var producer = ScopeJob.ProducerName(op["producer"]?.ToString() ?? "");
            if (producer.Length == 0) continue;
            if (!known.Producers.ContainsKey(producer)) known.Producers[producer] = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var element in (op["elements"] as JsonArray ?? []).Select(e => e?.ToString() ?? ""))
            {
                var colon = element.IndexOf(':');
                var name = element[(colon + 1)..].Trim();
                if (name.StartsWith('@') || name.Length == 0) known.Open.Add(producer);
                else Add(producer, name, colon > 0 ? element[..colon] : "");
            }
        }
        return known;
    }

    /// <summary>What a row of the index is inside: "reference" (a reference, at any depth), "owner" (a screen, a block, an
    /// action, a record: its screen actions and nodes are no module action), or null (the module's own).</summary>
    private static string? Holder(List<ModuleIndex.Row> rows, ModuleIndex.Row row)
    {
        var seen = 0;
        for (var p = row.Parent; p >= 0 && p < rows.Count && seen++ < 64; p = rows[p].Parent)
        {
            if (rows[p].Kind == "Reference") return "reference";
            if (rows[p].Role is "screen" or "block" or "action" or "actionRef" or "entity" or "staticEntity" or "structure") return "owner";
        }
        return null;
    }

    /// <summary>R2-A: the role of a kind a producer's element has in the index, a digest line or a reference op (a server
    /// action of a reference is its action, written with or without Signature).</summary>
    internal static string RoleOfKind(string kind) =>
        kind.Length == 0 ? "" : IndexBaseFacts.ScreenKind.IsMatch(kind) ? "screen" : IndexBaseFacts.BlockKind.IsMatch(kind) ? "block"
        : kind.Contains("Action", StringComparison.Ordinal) ? "actionRef" : NameResolution.IsRecord(kind, null) ? "entity" : "other";

    /// <summary>R2-A: the candidates of a call written <paramref name="name"/> (its last segment) from an action of
    /// <paramref name="owner"/>, from the index and the job (NameResolution decides; the apply asks the same of the model with
    /// the same declarations): the owner's own screen and data actions and those the job declares under it (tier 0), the
    /// module's own actions and those the job declares (1), every element of that name of a producer the module or the job
    /// references (2, written Producer.Name). Each with its name as the element has it (a name written in another case is
    /// written as the element is named). A producer's element written without its kind fits (its kind is not known here).</summary>
    internal static IEnumerable<NameCandidate> CallCandidates(string name, string? owner, Callables k)
    {
        if (owner != null)
        {
            foreach (var block in new[] { false, true })
                if (k.Index.Root(owner, block) is { } root)
                {
                    foreach (var (kind, names) in root.Children)
                        if (kind.Contains("Action", StringComparison.Ordinal) || kind.Contains("Preparation", StringComparison.Ordinal))
                            foreach (var own in names.Where(n => string.Equals(n, name, StringComparison.OrdinalIgnoreCase)))
                                yield return new(own, kind, "action", 0, own, owner, true);
                    break;
                }
        }
        foreach (var candidate in NameResolution.Declared(k.Declared.Where(d => string.Equals(d.Name, name, StringComparison.OrdinalIgnoreCase)), owner))
            yield return candidate;
        if (k.ModuleActions.TryGetValue(name, out var mine))
            foreach (var kind in mine.Kinds) yield return new(mine.Name, kind, kind.EndsWith("ActionSignature", StringComparison.Ordinal) ? "actionRef" : "action", 1, mine.Name);
        foreach (var (producer, elements) in k.ProducerKinds)
            if (elements.TryGetValue(name, out var element))
                foreach (var kind in element.Kinds) yield return new(element.Name, kind, RoleOfKind(kind), 2, producer + "." + element.Name, producer);
    }

    /// <summary>R2-A: every candidate of a call from <paramref name="owner"/> whatever its name (the nearest names of a refusal).</summary>
    private static IEnumerable<NameCandidate> CallPool(string? owner, Callables k)
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        names.UnionWith(k.ModuleActions.Keys);
        foreach (var elements in k.ProducerKinds.Values) names.UnionWith(elements.Keys);
        names.UnionWith(k.Declared.Select(d => d.Name));
        if (owner != null) names.UnionWith(k.OwnerActions(owner) ?? []);
        return names.SelectMany(n => CallCandidates(n, owner, k));
    }

    /// <summary>R2-A: the element a call written <paramref name="callee"/> reaches from an action of <paramref name="owner"/>
    /// (NameResolution over the index's candidates); the same rule decides it at apply with the model's candidates.</summary>
    internal static NameAnswer ResolveCall(string callee, string? owner, Callables k)
        => NameResolution.Resolve(callee, CallCandidates(NameResolution.Parse(callee).Name, owner, k), NameResolution.Call, () => CallPool(owner, k));

    /// <summary>R2-A: what a call never gets a canonical form for, in the preflight and the apply alike: a built-in and a
    /// function of the System (their texts name them bare).</summary>
    internal static bool NeverCanonical(string callee, string lane) =>
        Builtins.For(lane)?.ContainsKey(callee) == true || SystemCalls.Inputs.ContainsKey(callee);

    /// <summary>R2-A: the canonical form of a call (NameResolution over the index), or null when the text already writes it:
    /// a producer's action written without its producer (one action of that name, of one producer, nothing of the module's,
    /// of the owner's or of the job's), and any call written in another case than its element's name (bare, or qualified by
    /// its producer). A producer this reader does not see whole (clipped, imported by key) may hold the name too: never
    /// rewritten then.</summary>
    internal static string? CanonicalCall(string callee, string? owner, Callables k, string lane)
    {
        callee = callee.Trim();
        if (callee.Length == 0 || callee.IndexOfAny([':', '/', '@', '$', '(']) >= 0) return null;
        var dot = callee.IndexOf('.');
        if (dot >= 0 && (callee.LastIndexOf('.') != dot || !k.ProducerKinds.ContainsKey(callee[..dot]))) return null;
        if (dot < 0 && NeverCanonical(callee, lane)) return null;
        if (dot < 0 && EntityAction.Match(callee) is { Success: true } entity && k.IsRecord(entity.Groups[1].Value)) return null;
        var answer = ResolveCall(callee, owner, k);
        if (answer is not { Outcome: NameOutcome.Resolved, Canonicalized: true, Chosen: { } chosen }) return null;
        if (chosen.Qualifier is { } producer && chosen.Canonical.StartsWith(producer + ".", StringComparison.Ordinal)
            && k.Open.Any(o => !string.Equals(o, producer, StringComparison.OrdinalIgnoreCase))) return null;
        return chosen.Canonical;
    }

    /// <summary>Why a callee does not resolve, with its candidates (each the form that names it: Producer.Action for a
    /// producer's), and whether it is ambiguous (two or more actions at the same distance) rather than unknown.</summary>
    internal sealed record Unresolved(string Why, List<string> Candidates, bool Ambiguous = false);

    /// <summary>Null when the callee resolves (or cannot be judged); else why not and the candidates. R2-A: a call is
    /// resolved by NameResolution over the candidates of the index (the apply decides with the same rule over the model's):
    /// the kind of a call (an action) enters the search, the nearest tier answers, one candidate resolves (a producer's action
    /// written without its producer too: JobNormalizer.WithBase wrote its canonical form before this phase), two or more at
    /// the same distance are refused with each one's form.</summary>
    internal static Unresolved? Resolve(string callee, string? owner, Callables k, bool screen = false)
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
            // Flow/Screen (a navigate): a screen of the module, of a reference or of the job, or a destination of the System.
            // R2-A (NameResolution, the slot Navigation): the kind enters the search, so a name only an action, a block or a
            // record has is no destination. A navigate has no tiers here: two screens of the name are the apply's to pick.
            var target = callee.Split('/').Last();
            // C-22: the Previous Screen (`navigate ()`, read as navigate PreviousScreen()) is a destination of every module.
            if (k.SystemDestinations.Contains(target) || k.JobDeclares(target) || target == FlowParser.PreviousScreen) return null;
            var named = k.Index.KindsOf(target).Select(kind => new NameCandidate(target, kind, RoleOfKind(kind), 1, target)).ToList();
            if (k.Job.Roots.TryGetValue(target, out var rootKind))
                named.Add(rootKind.Contains("block", StringComparison.OrdinalIgnoreCase) ? new(target, "Block", "block", 1, target) : new(target, "Screen", "screen", 1, target));
            if (k.Index.Root(target, false) != null) named.Add(new(target, "Screen", "screen", 1, target));
            var place = NameResolution.Resolve(target, named, NameResolution.Navigation);
            if (place.Outcome != NameOutcome.Unknown) return null;
            var screens = k.Index.Roots("screen").Concat(k.Job.Roots.Where(r => !r.Value.Contains("block", StringComparison.OrdinalIgnoreCase)).Select(r => r.Key))
                .Concat(k.Index.NamesOf(kind => IndexBaseFacts.ScreenKind.IsMatch(kind)));
            return new(place.Unfit.Count > 0 ? $"'{target}' is {string.Join(", ", place.Unfit.Select(x => "a " + NameResolution.Bare(x.Kind)).Distinct())} of the module or of a reference, and a navigate goes to a screen"
                : $"no screen of the module or of this job is named '{target}'", Candidates(target, screens));
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
                return new($"'{qualifier}' has no screen action or data action '{name}', and no logic op of this job declares {qualifier}.{name}", Candidates(name, actions.Concat(mine)));
            }
            if (k.Open.Contains(qualifier)) return null;
            if (k.Producers.TryGetValue(qualifier, out var names))
            {
                if (!names.Contains(name))
                    return new($"'{name}' is not an element of {qualifier} that this module references or that a reference op of this job imports", Candidates(name, names).Select(n => qualifier + "." + n).ToList());
                // R2-A: an element of the producer of another kind (a structure, a screen) is no call.
                var typed = ResolveCall(callee, owner, k);
                return typed.Outcome != NameOutcome.Unknown || typed.Unfit.Count == 0 ? null
                    : new($"{string.Join(", ", typed.Unfit.Select(NameResolution.Describe))} is no action, and a call executes an action", typed.Candidates.Select(c => c.Canonical).ToList());
            }
            // A qualifier that is no module, owner or producer of the base or of the job.
            if (k.Index.TopLevel(qualifier)) return null;
            return new($"'{qualifier}' is no module this module references, no reference op of this job imports it, and no screen or block is named so",
                Candidates(qualifier, k.Producers.Keys.Concat(k.Index.Roots("screen")).Concat(k.Index.Roots("block"))));
        }
        // Bare: a built-in, a function of the System, an entity action; else the actions the call can name (NameResolution): of
        // the owner, of the module and of the job, then of the producers (written Producer.Action).
        if (k.Builtins?.ContainsKey(callee) == true || SystemCalls.Inputs.ContainsKey(callee)) return null;
        if (EntityAction.Match(callee) is { Success: true } entity && k.IsRecord(entity.Groups[1].Value)) return null;
        var answer = ResolveCall(callee, owner, k);
        if (answer.Outcome == NameOutcome.Resolved) return null;
        // Two or more at the same distance, in the text form and in the JSON form alike (the JSON form writes the one it means
        // as Producer.Action too: LogicOrder.CallCandidates).
        if (answer.Outcome == NameOutcome.Ambiguous)
            return new($"{answer.Candidates.Count} actions answer '{callee}' at the same distance ({string.Join(", ", answer.Candidates.Select(NameResolution.Describe))}), and the call names none of them",
                answer.Candidates.Select(c => c.Canonical).Distinct(StringComparer.OrdinalIgnoreCase).ToList(), true);
        // No action has the name: an element of the module of another kind (a screen, a block), a function, a name the job
        // declares by another op (a raw create, a reference op), a producer this reader does not see whole or a generator op
        // is the apply's to judge.
        if (k.Local.Contains(callee) || k.IsOwner(callee) || k.Index.IsFunction(callee) || k.JobDeclares(callee)
            || owner != null && k.JobDeclares(owner + "." + callee)) return null;
        if (k.Open.Count > 0 || k.Job.Generators) return null;
        return new($"no action of the module, of its references or of this job is named '{callee}'"
            + (answer.Unfit.Count > 0 ? $" ({string.Join(", ", answer.Unfit.Take(3).Select(NameResolution.Describe))} of that name is no action)" : ""),
            answer.Candidates.Select(c => c.Canonical).ToList());
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
                    var problem = CallProblem(i, at, call.Target, why, at == null ? null : at + "/call", call.Target, "LOGIC_INVALID");
                    if (at != null) Choices(problem, why, call.Target, form => new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = at + "/call", ["value"] = form }));
                    yield return problem;
                }
            }
            foreach (var (index, text) in DocumentNameRules.Texts(data))
            {
                FlowItem parsed;
                try { parsed = FlowParser.Parse(text); } catch { continue; }   // a text the grammar refuses is the preflight's
                var owner = parsed.Owner.Length > 0 ? parsed.Owner.Split('/').Last() : null;
                var at = prefix == null ? null : $"{prefix}/{i}/" + TextPath(data, index);
                foreach (var (callee, screen) in Callees(parsed))
                {
                    if (Resolve(callee, owner, known, screen) is not { } why || !seen.Add(callee)) continue;
                    var problem = CallProblem(i, at, callee, why, null, null, why.Ambiguous ? "FLOW_NAME_AMBIGUOUS" : "FLOW_NAME_UNKNOWN");
                    if (at != null)
                    {
                        // The certain correction (one candidate the name can mean), written in the text of the action; and the
                        // patch of each candidate (R2-A: the exact text with that one, only the call changed).
                        if (!why.Ambiguous && Meant(callee, why.Candidates) is { } meant && RewriteCalls(text, new Dictionary<string, string> { [callee] = Form(callee, meant) }) is { } corrected)
                            problem["patch"] = new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = at, ["value"] = corrected });
                        Choices(problem, why, callee, form => RewriteCalls(text, new Dictionary<string, string> { [callee] = form }) is { } chosen
                            ? new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = at, ["value"] = chosen }) : null);
                    }
                    yield return problem;
                }
            }
        }
    }

    /// <summary>The path of a text of the text form under the op (data/flow, data/flow/N, data/flow/N/text, data/text...).</summary>
    private static string TextPath(JsonObject data, int index)
    {
        var key = data["flow"] != null ? "flow" : "text";
        return data[key] is JsonArray list ? $"data/{key}/{index}" + (list[index] is JsonObject ? "/text" : "") : $"data/{key}";
    }

    private static readonly Regex CallLine = new(@"^(\s*(?:[A-Za-z_]\w*\s*=\s*)?)(\S+?)(?=\s*\()", RegexOptions.Compiled);

    /// <summary>R2-A: the text with the callee of its Execute nodes written as <paramref name="forms"/> says (callee as written →
    /// its form), and nothing else: only the name before the parenthesis of a call line, never a literal, a comment, a
    /// description or an expression (an assignment that calls the same name as a function keeps it). Each line is checked by
    /// parsing: the action read from the new text is the action of the old one with those callees in their forms, or the line
    /// is left as it was. Null when no call changed (or a call of those names stays as it was written).</summary>
    internal static string? RewriteCalls(string text, IReadOnlyDictionary<string, string> forms)
    {
        FlowItem before;
        try { before = FlowParser.Parse(text); } catch { return null; }
        var target = Retargeted(before, forms).Canon();
        var lines = text.Split('\n');
        var changed = false;
        for (var n = 0; n < lines.Length; n++)
        {
            var line = lines[n];
            var trimmed = line.TrimStart();
            if (trimmed.StartsWith("//", StringComparison.Ordinal) || trimmed.StartsWith('#')) continue;
            if (CallLine.Match(line) is not { Success: true } call || !forms.TryGetValue(call.Groups[2].Value, out var form)) continue;
            var trial = (string[])lines.Clone();
            trial[n] = call.Groups[1].Value + form + line[call.Length..];
            FlowItem parsed;
            try { parsed = FlowParser.Parse(string.Join('\n', trial)); } catch { continue; }
            // The line is a call of the action when the new text means the old one with its callees retargeted.
            if (Retargeted(parsed, forms).Canon() != target) continue;
            lines = trial;
            changed = true;
        }
        if (!changed) return null;
        var after = string.Join('\n', lines);
        FlowItem result;
        try { result = FlowParser.Parse(after); } catch { return null; }
        return Executes(result).Any(forms.ContainsKey) || Retargeted(result, forms).Canon() != target ? null : after;
    }

    // The action with every Execute of a name in forms calling its form instead; the name of such a node is left out of the
    // comparison (a call written without a name is named after its callee's last segment, which a typo's patch changes).
    private static FlowItem Retargeted(FlowItem item, IReadOnlyDictionary<string, string> forms)
    {
        var copy = item.Clone();
        var targets = forms.Values.ToHashSet(StringComparer.Ordinal);
        void Visit(FlowItem node)
        {
            if (node.Role == "node" && node.Kind == "Execute" && node.Prop("Action") is { } action)
            {
                if (forms.TryGetValue(action, out var form)) { node.Props["Action"] = node.Props["Action"] with { Text = form }; action = form; }
                if (targets.Contains(action)) node.Name = "";
            }
            foreach (var child in node.Items) Visit(child);
        }
        Visit(copy);
        return copy;
    }

    /// <summary>R2-A: the candidates of a refused call, each with its form and the patch that writes it (the author chooses).</summary>
    private static void Choices(JsonObject problem, Unresolved why, string callee, Func<string, JsonArray?> patch)
    {
        if (why.Candidates.Count == 0) return;
        problem["candidates"] = new JsonArray(why.Candidates.Select(c => (JsonNode)new JsonObject { ["name"] = Form(callee, c), ["patch"] = patch(Form(callee, c)) }).ToArray());
        if (why.Ambiguous) problem["patch"] = null;
    }

    private static string Last(string name) => name.Split('.', '/').Last();

    /// <summary>Two neighbouring letters swapped (Fitler for Filter): the commonest typo, two edits apart.</summary>
    private static bool Transposed(string a, string b)
    {
        if (a.Length != b.Length || a.Length < 3) return false;
        var diff = Enumerable.Range(0, a.Length).Where(i => char.ToUpperInvariant(a[i]) != char.ToUpperInvariant(b[i])).ToList();
        return diff.Count == 2 && diff[1] == diff[0] + 1 && char.ToUpperInvariant(a[diff[0]]) == char.ToUpperInvariant(b[diff[1]]) && char.ToUpperInvariant(a[diff[1]]) == char.ToUpperInvariant(b[diff[0]]);
    }

    /// <summary>The one candidate a name can mean (NameSuggestions.OnlyMatch over their last segments), or null.</summary>
    internal static string? Meant(string callee, IReadOnlyList<string> candidates)
    {
        var name = Last(callee);
        var close = candidates.Where(c => Last(c) is var last && (last.Contains(name, StringComparison.OrdinalIgnoreCase) || name.Contains(last, StringComparison.OrdinalIgnoreCase)
            || NameSuggestions.Distance(name.ToUpperInvariant(), last.ToUpperInvariant()) <= Math.Max(1, Math.Min(name.Length, last.Length) / 4)
            || Transposed(name, last)))
            .DistinctBy(Last, StringComparer.OrdinalIgnoreCase).ToList();
        return close.Count == 1 ? close[0] : null;
    }

    /// <summary>How a candidate is written in place of <paramref name="written"/>: with the written qualifier (Producer.Typo is
    /// Producer.Name), or whole when the text had none (a producer's action is Producer.Name).</summary>
    private static string Form(string written, string candidate) => written.Contains('.') ? written[..(written.LastIndexOf('.') + 1)] + Last(candidate) : candidate;

    private static JsonObject CallProblem(int op, string? pointer, string callee, Unresolved why, string? patchPath, string? written, string predicts)
    {
        var meant = why.Ambiguous ? null : Meant(callee, why.Candidates);
        var patch = patchPath != null && written != null && meant != null
            ? new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = patchPath, ["value"] = Form(written, meant) }) : null;
        return Problem(op, pointer, why.Ambiguous ? CallAmbiguous : CallUnknown, predicts, $"the call {callee}(...): {why.Why}",
            why.Ambiguous ? $"write the one you mean: {string.Join(", ", why.Candidates.Select(c => Form(callee, c)))} (candidates: the patch of each)"
            : why.Candidates.Count > 0 ? $"call one of: {string.Join(", ", why.Candidates.Select(c => Form(callee, c)))}; or declare it earlier in this job (a logic op), or import it (a reference op); " + ProducerCallForm
                : "declare the action in a logic op of this job, import it with a reference op, or name an action of the module (ssam_map); " + ProducerCallForm, patch, "logic");
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

    /// <summary>The actions the Execute nodes of a parsed action call (the calls of its text, never a destination).</summary>
    internal static IEnumerable<string> Executes(FlowItem item)
    {
        if (item.Role == "node" && item.Kind == "Execute" && item.Prop("Action") is { Length: > 0 } action) yield return action;
        foreach (var child in item.Items)
            foreach (var callee in Executes(child)) yield return callee;
    }

    // ---- REFERENCE_CANONICAL (a normalization, with the base) -------------------------------------------------------------

    /// <summary>R2-A: a call of a producer's action written without its producer (one action of that name, of one producer,
    /// nothing of the module's, of the owner's or of the job's: NameResolution over the index), and a call written in another
    /// case than its element's name, is written in its canonical form (Producer.Action, the element's own spelling), the form
    /// the reading writes and the apply resolves; only the callee of the call line changes (RewriteCalls). Listed as
    /// REFERENCE_CANONICAL (JobNormalizer.WithBase, through ScopePhase.Normalize). The text form's calls only: the JSON form
    /// binds a bare name by Kind:Name over the whole module and Producer.Action by its reference (LogicOrder.CallCandidates).</summary>
    internal static void Canonicalize(JsonArray ops, string? prefix, string lane, IBaseFacts facts, List<JsonObject> done)
    {
        if (!ops.OfType<JsonObject>().Any(o => o["op"]?.ToString() == "logic" && o["data"] is JsonObject d && (d["flow"] ?? d["text"]) != null)) return;
        var index = facts as IndexBaseFacts ?? (facts as ModelBaseFacts)?.Indexed(ops, lane);
        if (index == null) return;
        var known = Known(index, ScopeJob.Of(ops), ops, lane);
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "logic" || op["data"] is not JsonObject data) continue;
            foreach (var (n, text) in DocumentNameRules.Texts(data))
            {
                FlowItem parsed;
                try { parsed = FlowParser.Parse(text); } catch { continue; }
                var owner = parsed.Owner.Length > 0 ? parsed.Owner.Split('/').Last() : null;
                var forms = new Dictionary<string, string>(StringComparer.Ordinal);
                foreach (var callee in Executes(parsed).Distinct(StringComparer.Ordinal))
                    if (CanonicalCall(callee, owner, known, lane) is { } form) forms[callee] = form;
                if (forms.Count == 0 || RewriteCalls(text, forms) is not { } written) continue;
                WriteText(data, n, written);
                var path = prefix == null ? null : $"{prefix}/{i}/" + TextPath(data, n);
                foreach (var (callee, form) in forms) done.Add(CanonicalNote(path, callee, form, "the apply resolves"));
            }
        }
    }

    /// <summary>The REFERENCE_CANONICAL entry of a call written <paramref name="callee"/> and now <paramref name="form"/>.</summary>
    internal static JsonObject CanonicalNote(string? path, string callee, string form, string who) => JobNormalizer.Entry(NameResolution.CanonicalRule, path, callee + "(", form + "(",
        string.Equals(callee, Last(form), StringComparison.OrdinalIgnoreCase) && !form.Contains('.') || string.Equals(callee, form, StringComparison.OrdinalIgnoreCase)
            ? $"{callee} names the action {form} (the names of a module have no case): written {form}, as the action is named and as {who}"
            : $"{callee} is the action {form} of a producer the module references (the only action of that name, and neither the module, the caller's owner nor this job has one): written {form}, the form the reading writes and {who}");

    private static void WriteText(JsonObject data, int index, string text)
    {
        var key = data["flow"] != null ? "flow" : "text";
        switch (data[key])
        {
            case JsonArray list when list[index] is JsonObject entry: entry["text"] = text; break;
            case JsonArray list: list[index] = text; break;
            default: data[key] = text; break;
        }
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
        // R3-B: the module types and their maps are the table's (PlatformLimits parent.map), a Service module's included.
        var fixture = PlatformLimits.MapFixture(moduleType);
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
        if (lane != "o11") yield break;
        var map = MapFor(moduleType);
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "create") continue;
            var type = KindNames.Normalize(op["type"]?.ToString() ?? "");
            var at = prefix == null ? null : $"{prefix}/{i}/type";
            // R3-B: a parent the table measured beyond the maps (an image in a Service module: the map's probe had no binary).
            var atModule = op["parent"]?.ToString() == "@espace";
            if (PlatformLimits.RefusedParent(lane, moduleType, type, atModule ? "IESpace" : ParentType(op["parent"]?.ToString(), job, i)) is { } measured)
            {
                yield return Problem(i, prefix == null ? null : $"{prefix}/{i}/parent", KindNode, "APPLY_FAILED", $"{type} under the module of a {moduleType} module: {measured.Message}", measured.Fix, null, "create");
                continue;
            }
            if (map == null) continue;
            // The Service map (new with R3-B) is read at the module too (`@espace`: a client variable, a client action, a theme, a
            // UI flow, a script); the UI maps keep the reach they had (a parent named by kind or by an alias of the job).
            var parentType = atModule && moduleType == "Service" ? "IESpace" : ParentType(op["parent"]?.ToString(), job, i);
            if (map.NoClass.Contains(type))
            {
                var other = Counterpart(type, map);
                yield return Problem(i, at, KindNode, "APPLY_FAILED", $"{type} has no class in a {moduleType} module (the Studio creates it only in another kind of module)",
                    other != null ? $"write {other}, the same widget of this module's kind" : "create the widget of this module's kind (ssam_map lists the widgets of a screen of this module)",
                    other != null && at != null ? new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = at, ["value"] = other }) : null, "create");
                continue;
            }
            if (parentType != null && map.NotChild.TryGetValue((type, parentType), out var refusal))
                yield return Problem(i, prefix == null ? null : $"{prefix}/{i}/parent", KindNode, "APPLY_FAILED", $"{type} under a {parentType}: {refusal}",
                    parentType == "IESpace" ? $"a {moduleType} module has no {type}: create it in a module of a kind that has one (docs/mapa/criar-{map.Fixture}.json lists what this one takes)"
                        : $"create the {type} under a container the {parentType} holds, or use a widget a {parentType} accepts", null, "create");
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

    private static readonly HashSet<string> ScopeGlobals = new(ExpressionRoots.All.Append("NullTextIdentifier"), StringComparer.OrdinalIgnoreCase);

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
