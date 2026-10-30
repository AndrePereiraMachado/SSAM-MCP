namespace Anvil.Reading;

/// <summary>One element a name of a text may reach, as the side that asks knows it (the preflight from the module index, the
/// apply from the model). <see cref="Tier"/>: how near the use it is (0 the owner's own, 1 the module's, 2 a reference's, more
/// further); <see cref="Canonical"/>: how the reading writes it from that use (the text of its patch); <see cref="Qualifier"/>:
/// what an Owner.Name or Producer.Name form names before the dot (the parent: a reference, a screen, a flow); <see cref="Own"/>:
/// it belongs to the owner of the use (a screen action of the caller's screen).</summary>
public sealed record NameCandidate(string Name, string Kind, string Role, int Tier, string Canonical, string? Qualifier = null, bool Own = false, object? Element = null);

/// <summary>What a use of a name takes: the word of its messages and the elements that fit it. <see cref="ByForm"/>: the
/// candidates written the same are one answer (a call: a server and a client action of one name are one form, and the kind of
/// the call, Call=, or of its flow picks the action at apply).</summary>
public sealed record NameSlot(string Word, Func<NameCandidate, bool> Fits, bool ByForm = false);

public enum NameOutcome { Resolved, Unknown, Ambiguous }

/// <summary>The answer of <see cref="NameResolution.Resolve"/>. <see cref="Candidates"/>: the one resolved (Resolved), the
/// candidates of the nearest tier (Ambiguous) or the nearest names of the slot (Unknown), each with its form (the patch);
/// <see cref="Unfit"/>: the elements of that name the use does not take (what a scope-first search would have answered).</summary>
public sealed record NameAnswer(NameOutcome Outcome, string Written, NameCandidate? Chosen, IReadOnlyList<NameCandidate> Candidates, IReadOnlyList<NameCandidate> Unfit)
{
    /// <summary>Resolved, and the text is not the form the reading writes for that element from this use (a producer's action
    /// written without its producer, a screen written bare beside a nearer parameter of its name): the caller writes or lists
    /// the canonical form (REFERENCE_CANONICAL), never changes the element silently. Ordinal: the canonical form is spelled as
    /// the element is named, so a name written in another case is listed and written as the element has it.</summary>
    public bool Canonicalized => Chosen != null && !string.Equals(Written.Trim(), Chosen.Canonical, StringComparison.Ordinal);

    /// <summary>The written text had no qualifier and the element is a producer's (the reading writes Producer.Name).</summary>
    public bool Qualified => Chosen is { Qualifier: { Length: > 0 } q } && !Written.Contains('.') && Chosen.Canonical.StartsWith(q + ".", StringComparison.OrdinalIgnoreCase);
}

/// <summary>
/// R2-A (2026-10-29): the one rule of "the element a name of a text reaches", for every text form (ssam-flow/1 calls and
/// destinations, ssam-html/1 events and references) and both sides of a job: the preflight builds the candidates from the
/// module index, the apply from the model, and this pure function decides for both (the preflight accepted the short form of
/// a producer's action that the apply refused, and an event resolved to a nearer parameter named like the screen it opens:
/// the family K4 of 28/10).
/// <list type="number">
/// <item>The kind the use takes enters the search (<see cref="NameSlot.Fits"/>), before the scope: a parameter, a variable or
/// an action of another kind named like the screen an event opens is no candidate, however near.</item>
/// <item>Among the candidates that fit, the nearest tier answers (the owner's own, the module's, the references').</item>
/// <item>Exactly one: resolved; when the text is not the reading's form of it (<see cref="NameAnswer.Canonicalized"/>), the
/// caller writes the canonical form and says so in its normalizations.</item>
/// <item>None, or two or more at the nearest tier: refused once by the caller, with the candidates and the form of each.</item>
/// </list>
/// Dependency-free (shared by both kernels and the ODC builder).
/// </summary>
public static class NameResolution
{
    /// <summary>The normalization a resolved short form gets (the canonical form is written, or listed).</summary>
    public const string CanonicalRule = "REFERENCE_CANONICAL";

    /// <summary>The destinations of the System an event or a navigate reaches with no reference of the module (both lanes:
    /// RedirectToURL; ODC labs 228 and 242, O11 SecurityNativeMessageTests).</summary>
    public static readonly IReadOnlySet<string> SystemDestinations = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "RedirectToURL" };

    // ---- the slots ------------------------------------------------------------------------------------------------------

    /// <summary>What a node executes: an action (server, client, service, a screen action of the caller's own owner, a
    /// producer's action signature). Never a data action, a preparation, a screen, a block, a record or a parameter. A
    /// candidate of unknown kind (a reference op's element written without its kind) cannot be judged and fits.</summary>
    public static readonly NameSlot Call = new("action", c => c.Kind.Length == 0
        || c.Role is "action" or "actionRef" && !c.Kind.Contains("DataAction", StringComparison.Ordinal) && !c.Kind.Contains("Preparation", StringComparison.Ordinal), ByForm: true);

    /// <summary>What an event runs or opens: a screen (of the module or of a reference), a screen action of the event's own
    /// screen or block, or a destination of the System.</summary>
    public static readonly NameSlot EventDestination = new("screen or screen action", c => c.Kind.Length == 0 || IsEventDestination(c.Kind, c.Role, c.Own, c.Name));

    /// <summary>Where a navigate goes: a screen (of the module or of a reference) or a destination of the System.</summary>
    public static readonly NameSlot Navigation = new("screen", c => c.Kind.Length == 0 || IsScreen(c.Kind, c.Role) || IsSystemDestination(c.Kind, c.Name));

    public static bool IsScreen(string kind, string? role) => role == "screen" || kind.EndsWith("ScreenSignature", StringComparison.Ordinal);

    public static bool IsSystemDestination(string kind, string name) => SystemDestinations.Contains(name) && kind.Contains("Action", StringComparison.Ordinal);

    /// <summary>The one predicate of an event's destination, for the edit and the document form of ssam-html/1 and the
    /// preflight: <paramref name="own"/> says the action belongs to the event's own screen or block.</summary>
    public static bool IsEventDestination(string kind, string? role, bool own, string name) =>
        IsScreen(kind, role) || role == "action" && own || IsSystemDestination(kind, name);

    public static bool IsRecord(string kind, string? role)
    {
        var k = Bare(kind);
        if (k.EndsWith("Signature", StringComparison.Ordinal)) k = k[..^"Signature".Length];
        return role is "entity" or "staticEntity" or "structure" || k is "Entity" or "ServerEntity" or "StaticEntity" or "ClientEntity" or "Structure";
    }

    // ---- the rule -------------------------------------------------------------------------------------------------------

    /// <summary>A written name as Kind:Qualifier.Name (Kind and Qualifier optional; a Kind is an identifier, its I prefix and
    /// namespace dropped: OutSystems.Model.UI.Mobile.IScreenAction is ScreenAction).</summary>
    public static (string? Kind, string? Qualifier, string Name) Parse(string written)
    {
        var rest = written.Trim();
        string? kind = null;
        var colon = rest.IndexOf(':');
        if (colon > 0 && IsKindWord(rest[..colon])) { kind = Bare(rest[..colon]); rest = rest[(colon + 1)..]; }
        var dot = rest.LastIndexOf('.');
        return dot > 0 ? (kind, rest[..dot], rest[(dot + 1)..]) : (kind, null, rest);
    }

    private static bool IsKindWord(string text) => text.Length > 0 && text.All(c => char.IsLetterOrDigit(c) || c is '.' or '_');

    /// <summary>A kind without its namespace and its I prefix (IMobileScreen and OutSystems.Model.UI.Mobile.IMobileScreen are MobileScreen).</summary>
    public static string Bare(string kind)
    {
        var k = kind[(kind.LastIndexOf('.') + 1)..];
        return k.Length > 1 && k[0] == 'I' && char.IsUpper(k[1]) ? k[1..] : k;
    }

    /// <summary>The element a written name reaches among <paramref name="named"/> (the candidates whose name is the written
    /// name's last segment, of any kind), for a use that takes <paramref name="slot"/>. <paramref name="pool"/>: every
    /// candidate of the use whatever its name (the nearest names of a refusal), asked only when nothing fits.</summary>
    public static NameAnswer Resolve(string written, IEnumerable<NameCandidate> named, NameSlot slot, Func<IEnumerable<NameCandidate>>? pool = null)
    {
        var (kind, qualifier, name) = Parse(written);
        var matches = named.Where(c => string.Equals(c.Name, name, StringComparison.OrdinalIgnoreCase)
            && (qualifier == null || string.Equals(c.Qualifier, qualifier, StringComparison.OrdinalIgnoreCase))
            && (kind == null || string.Equals(Bare(c.Kind), kind, StringComparison.Ordinal))).ToList();
        var fit = matches.Where(slot.Fits).ToList();
        var unfit = Distinct(matches.Where(c => !slot.Fits(c))).ToList();
        if (fit.Count == 0)
        {
            var near = pool == null ? new List<NameCandidate>() : Closest(name, Distinct(pool().Where(slot.Fits)).ToList(), 5);
            return new(NameOutcome.Unknown, written, null, near, unfit);
        }
        var nearest = fit.Min(c => c.Tier);
        var tier = Distinct(fit.Where(c => c.Tier == nearest)).ToList();
        if (slot.ByForm && tier.Count > 1 && tier.Select(c => c.Canonical).Distinct(StringComparer.OrdinalIgnoreCase).Count() == 1) tier = [tier[0]];
        return tier.Count == 1 ? new(NameOutcome.Resolved, written, tier[0], tier, unfit) : new(NameOutcome.Ambiguous, written, null, tier, unfit);
    }

    // One element answers once (the same node reached by two lookups; without a node, one form: a screen of the module that the
    // index and the digest both list, a producer's element of the index and of a reference op).
    private static IEnumerable<NameCandidate> Distinct(IEnumerable<NameCandidate> candidates)
    {
        var elements = new HashSet<object>(ReferenceEqualityComparer.Instance);
        var forms = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var c in candidates)
            if (c.Element is { } e && e is not string ? elements.Add(e) : forms.Add((c.Element as string ?? "") + "|" + c.Canonical))
                yield return c;
    }

    /// <summary>The nearest candidates by edit distance of their names (case-insensitive), at most <paramref name="max"/>.</summary>
    public static List<NameCandidate> Closest(string name, IReadOnlyList<NameCandidate> pool, int max) =>
        pool.Where(c => c.Name.Length > 0).GroupBy(c => c.Canonical, StringComparer.OrdinalIgnoreCase).Select(g => g.First())
            .OrderBy(c => Distance(name.ToUpperInvariant(), c.Name.ToUpperInvariant())).ThenBy(c => c.Tier).ThenBy(c => c.Canonical, StringComparer.Ordinal).Take(max).ToList();

    public static int Distance(string a, string b)
    {
        var previous = Enumerable.Range(0, b.Length + 1).ToArray();
        for (var i = 1; i <= a.Length; i++)
        {
            var row = new int[b.Length + 1]; row[0] = i;
            for (var j = 1; j <= b.Length; j++) row[j] = Math.Min(Math.Min(row[j - 1] + 1, previous[j] + 1), previous[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1));
            previous = row;
        }
        return previous[b.Length];
    }

    /// <summary>"Kind Name" of a candidate, for a message (ServerActionSignature Orders.Pay).</summary>
    public static string Describe(NameCandidate c) => (c.Kind.Length > 0 ? Bare(c.Kind) + " " : "") + c.Canonical;

    // ---- the model's side (the apply) ----------------------------------------------------------------------------------

    /// <summary>The candidates of a call among the callable elements of a model (the apply's source: Verbs.Flow gathers them
    /// once per text, as FlowExtractor names them): a screen or block action only of <paramref name="owner"/> (tier 0), the
    /// module's own (1), a reference's (2, written Producer.Name).</summary>
    public static IEnumerable<NameCandidate> ModelCalls<T>(ModelReader<T> reader, IEnumerable<T> callables, string? owner) where T : class
    {
        foreach (var element in callables)
        {
            var name = reader.DisplayOf(element);
            if (name.Length == 0) continue;
            var kind = reader.KindOf(element);
            var role = ModuleIndex.Roles[ModuleIndex.RoleOf(kind, new HashSet<string>(reader.KindNamesOf(element), StringComparer.Ordinal))];
            var parent = reader.ParentOf(element);
            if (parent != null && reader.KindOf(parent) == "Reference")
            {
                var producer = reader.DisplayOf(parent);
                yield return new(name, kind, role, 2, producer + "." + name, producer, false, element);
            }
            else if (parent != null && ModuleIndex.Roles[ModuleIndex.RoleOf(reader.KindOf(parent), new HashSet<string>(reader.KindNamesOf(parent), StringComparer.Ordinal))] is "screen" or "block")
            {
                // Another screen's or block's action is never what a call names (Verbs.Flow.Callee: the caller's owner only).
                var holder = reader.DisplayOf(parent);
                if (owner != null && string.Equals(holder, owner, StringComparison.OrdinalIgnoreCase)) yield return new(name, kind, role, 0, name, holder, true, element);
            }
            else yield return new(name, kind, role, 1, name, null, false, element);
        }
    }

    /// <summary>What a call written <paramref name="written"/> reaches from an action of <paramref name="owner"/> among the
    /// callable elements of a model (Verbs.Flow at apply; the parity tests with the module index at preflight).
    /// <paramref name="declared"/>: the actions the job declares (ScopeJob.DeclaredActions as <see cref="Declared"/>), which may
    /// not exist in the model yet: the preflight counts them, so the apply does too.</summary>
    public static NameAnswer ModelCall<T>(ModelReader<T> reader, IReadOnlyCollection<T> callables, string written, string? owner,
        IReadOnlyList<(string? Owner, string Name, string Kind)>? declared = null) where T : class
    {
        var name = Parse(written).Name;
        var extra = Declared(declared ?? [], owner).ToList();
        return Resolve(written, ModelCalls(reader, callables.Where(e => string.Equals(reader.DisplayOf(e), name, StringComparison.OrdinalIgnoreCase)), owner)
                .Concat(extra.Where(c => string.Equals(c.Name, name, StringComparison.OrdinalIgnoreCase))),
            Call, () => ModelCalls(reader, callables, owner).Concat(extra));
    }

    /// <summary>The candidates of a call among the actions a job declares (owner, name, kind as the declaration writes them): an
    /// action of <paramref name="owner"/> (tier 0), a module action (1); an action of another owner is never a call's.</summary>
    public static IEnumerable<NameCandidate> Declared(IEnumerable<(string? Owner, string Name, string Kind)> declared, string? owner)
    {
        foreach (var (of, name, kind) in declared)
            if (of == null) yield return new(name, kind, "action", 1, name);
            else if (owner != null && string.Equals(of, owner, StringComparison.OrdinalIgnoreCase)) yield return new(name, kind, "action", 0, name, of, true);
    }

    /// <summary>Every element of a model a call can name (the kinds Verbs.Flow.Callee gathers: action signatures and every
    /// kind of action).</summary>
    public static IEnumerable<T> ModelCallables<T>(ModelReader<T> reader, T module) where T : class =>
        reader.Walk(module).Where(e => reader.IsKind(e, "ActionSignature") || reader.KindOf(e).EndsWith("Action", StringComparison.Ordinal)
            || reader.KindOf(e).EndsWith("ActionSignature", StringComparison.Ordinal));
}
