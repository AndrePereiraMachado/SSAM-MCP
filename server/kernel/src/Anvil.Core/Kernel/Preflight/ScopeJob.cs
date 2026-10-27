using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core.Preflight;

/// <summary>
/// R1 (2026-10-24): what each op of a job declares and what it uses, read from the ops alone, for the scope phase. A
/// declaration is a name the op makes exist (an alias, an element by name, a screen action of a document, an action of a
/// logic text, a record of a spec, an element a reference op imports), kept bare and qualified by its owner
/// (<c>Home.Save</c>). A use is a name the op needs to exist before it runs: the parent and target of a raw op, the
/// destination it writes, the calls and the destinations of a logic text, the blocks and handlers of a document. The raw
/// elements a job creates are kept with their type and their owner (the screen or block they are inside).
/// </summary>
internal sealed class ScopeJob
{
    /// <summary>An element a raw `create` makes (or an html fragment op's id): its type, name, owner and op.</summary>
    internal sealed class Element
    {
        public string? Alias { get; init; }
        public string Type { get; init; } = "";
        public string? Name { get; init; }
        public int Op { get; init; }
        public string? ParentRef { get; init; }
        public Element? Parent { get; init; }
        /// <summary>The screen or block it is inside (its own name when it is one), with the kind (screen, block).</summary>
        public string? Owner { get; init; }
        public string? OwnerKind { get; init; }
        public List<Element> Children { get; } = [];
    }

    /// <summary>A name an op needs: <see cref="Qualified"/> when its owner is known (Owner.Name), the kind of use and where.</summary>
    internal sealed record Use(string Name, string? Qualified, string Kind, string? At);

    internal sealed class OpFacts
    {
        public int Index { get; init; }
        public string Kind { get; init; } = "";
        public HashSet<string> Declares { get; } = new(StringComparer.OrdinalIgnoreCase);
        public List<Use> Uses { get; } = [];
    }

    public List<OpFacts> Ops { get; } = [];
    /// <summary>The target of each `set` op, as written.</summary>
    public Dictionary<int, string> Targets { get; } = [];
    /// <summary>What the root alias of a `set` target or a `create` parent named when that op was read (an alias a later op
    /// declares again is another element from there on), and the owner it was inside.</summary>
    public Dictionary<int, Element> AliasAt { get; } = [];
    public Dictionary<int, (string? Owner, string? Kind)> OwnerAt { get; } = [];
    /// <summary>The aliases more than one op declares (a composite job of parts): a rule over the whole job leaves them alone.</summary>
    public HashSet<string> Reused { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, Element> Aliases { get; } = new(StringComparer.Ordinal);
    /// <summary>Every element a raw create makes with an alias, in op order.</summary>
    public List<Element> Elements { get; } = [];
    /// <summary>The screens and blocks the job makes (raw creates and documents), by name: their kind.</summary>
    public Dictionary<string, string> Roots { get; } = new(StringComparer.OrdinalIgnoreCase);
    /// <summary>The ops that make aliases the reader cannot list (a spec, a screen generator, an entity-actions op...).</summary>
    public bool OpenAliases { get; private set; }
    /// <summary>The job has an op that makes elements whose names this reader cannot list (a REST or SOAP consume, a screen
    /// generator, entity actions, a prototype): a name nothing else declares may be one of them.</summary>
    public bool Generators { get; private set; }

    private static readonly Regex FlowHeader = new(@"^(server action|service action|client action|data action|preparation|action)[ \t]+(?:([\w/]+)\.)?([A-Za-z_]\w*)", RegexOptions.Compiled | RegexOptions.Multiline);
    private static readonly Regex FlowParameter = new(@"^\s{1,2}(?:in|out|local)\s+([A-Za-z_]\w*)\s*:", RegexOptions.Compiled | RegexOptions.Multiline);
    // A call of a flow line: `P.A(`, `A(`, `X = P.A(`, `navigate S(`; never inside a text literal (stripped first).
    private static readonly Regex FlowCall = new(@"(?:^|[=\s(,])((?:\(System\)\.)?[A-Za-z_]\w*(?:[./][A-Za-z_]\w*)*)\s*\(", RegexOptions.Compiled);
    private static readonly Regex Literal = new("\"(?:[^\"]|\"\")*\"", RegexOptions.Compiled);
    internal static readonly HashSet<string> ScreenTypes = new(StringComparer.Ordinal) { "IMobileScreen", "IWebScreen", "IScreen" };
    internal static readonly HashSet<string> BlockTypes = new(StringComparer.Ordinal) { "IMobileBlock", "IWebBlock", "IBlock", "IWebEmail", "IEmail" };

    public static ScopeJob Of(JsonArray ops)
    {
        var job = new ScopeJob();
        for (var i = 0; i < ops.Count; i++)
        {
            var facts = new OpFacts { Index = i, Kind = (ops[i] as JsonObject)?["op"]?.ToString() ?? "" };   // an op that is no object has no kind
            job.Ops.Add(facts);
            if (ops[i] is not JsonObject op) continue;
            try { job.Read(op, facts); } catch { /* an op the reader cannot follow declares and uses nothing here */ }
        }
        return job;
    }

    private void Read(JsonObject op, OpFacts facts)
    {
        switch (facts.Kind)
        {
            case "create": Create(op, facts); break;
            case "set":
                UseReference(op["target"]?.ToString(), "target", facts);
                if (op["target"]?.ToString() is { Length: > 0 } written)
                {
                    Targets[facts.Index] = written;
                    if (ParentElement(written) is { } at) AliasAt[facts.Index] = at;
                    OwnerAt[facts.Index] = OwnerOf(written);
                }
                // A destination (`IMobileScreen:Home`, `IMobileBlock:B/IScreenAction:Save`) or another reference as the value.
                if (op["value"] is JsonValue v && v.TryGetValue<string>(out var value))
                {
                    if (LooksLikeReference(value)) UseReference(value, "value", facts);
                    else if (OwnerOf(op["target"]?.ToString()).Owner is { } owner)
                        foreach (var root in RootNames(value)) facts.Uses.Add(new Use(root, owner + "." + root, "expression", "value"));
                }
                break;
            case "link": UseReference(op["from"]?.ToString(), "from", facts); UseReference(op["to"]?.ToString(), "to", facts); break;
            case "delete": case "move": case "layout": UseReference(op["target"]?.ToString(), "target", facts); break;
            case "rename":
                UseReference(op["target"]?.ToString(), "target", facts);
                if (op["name"]?.ToString() is { Length: > 0 } renamed) facts.Declares.Add(renamed);
                break;
            case "html": Html(op, facts); break;
            case "logic": Logic(op, facts); break;
            case "spec":
                OpenAliases = true;
                if (op["data"] is JsonObject data)
                {
                    foreach (var name in SpecExpander.DdlNames(data)) facts.Declares.Add(name);
                    foreach (var section in new[] { "entities", "clientEntities", "static", "structures" })
                        foreach (var record in (SpecExpander.Sections(data)[section] as JsonArray ?? []).OfType<JsonObject>())
                            if (record["name"]?.ToString() is { Length: > 0 } recordName) facts.Declares.Add(recordName);
                }
                break;
            case "reference":
                var producer = op["producer"]?.ToString() ?? "";
                foreach (var element in (op["elements"] as JsonArray ?? []).Select(e => e?.ToString() ?? ""))
                {
                    var name = element[(element.IndexOf(':') + 1)..].Trim();
                    if (name.Length == 0 || name.StartsWith('@')) continue;
                    facts.Declares.Add(name);
                    if (producer.Length > 0) facts.Declares.Add(ProducerName(producer) + "." + name);
                }
                break;
            default:
                // A generator (screen, entity-actions, prototype, rest...) makes names and aliases this reader does not plan.
                OpenAliases = true; Generators = true;
                if (op["name"]?.ToString() is { Length: > 0 } generated) facts.Declares.Add(generated);
                break;
        }
    }

    private void Create(JsonObject op, OpFacts facts)
    {
        var parentRef = op["parent"]?.ToString();
        UseReference(parentRef, "parent", facts);
        if (op["source"]?.ToString() is { Length: > 0 } source) UseReference(source, "source", facts);
        var type = KindNames.Normalize(op["type"]?.ToString() ?? "");
        var name = op["name"]?.ToString();
        var parent = ParentElement(parentRef);
        var (owner, ownerKind) = ScreenTypes.Contains(type) ? (name, "screen") : BlockTypes.Contains(type) ? (name, "block") : parent != null ? (parent.Owner, parent.OwnerKind) : OwnerOf(parentRef);
        var element = new Element { Alias = op["as"]?.ToString(), Type = type, Name = name, Op = facts.Index, ParentRef = parentRef, Parent = parent, Owner = owner, OwnerKind = ownerKind };
        parent?.Children.Add(element);
        if (parent != null) AliasAt[facts.Index] = parent;
        if (element.Alias is { Length: > 0 } alias)
        {
            if (Aliases.ContainsKey(alias)) Reused.Add(alias);
            Aliases[alias] = element; Elements.Add(element); facts.Declares.Add(alias);
        }
        if (name is { Length: > 0 })
        {
            facts.Declares.Add(name);
            if (owner != null && !string.Equals(owner, name, StringComparison.OrdinalIgnoreCase)) facts.Declares.Add(owner + "." + name);
            if (ownerKind != null && owner == name) Roots[name] = ownerKind;
        }
    }

    private void Html(JsonObject op, OpFacts facts)
    {
        var html = op["data"]?["html"]?.ToString() ?? op["html"]?.ToString();
        if (html == null) { OpenAliases = true; return; }
        if (op["parent"]?.ToString() is { Length: > 0 } parent) UseReference(parent, "parent", facts);
        HtmlText text;
        try { text = HtmlText.Parse(html); } catch { return; }
        var doc = ScreenDocFacts.Of(op, facts.Index);
        var (owner, _) = doc != null ? (doc.Name, doc.Kind) : ParentElement(op["parent"]?.ToString()) is { } p ? (p.Owner, p.OwnerKind) : OwnerOf(op["parent"]?.ToString());
        if (doc != null)
        {
            Roots[doc.Name] = doc.Kind;
            facts.Declares.Add(doc.Name);
            // Its data is its own; its screen actions and data actions are written by logic ops (used here, declared there).
            foreach (var d in doc.Declared) { facts.Declares.Add(d.Name); facts.Declares.Add(doc.Name + "." + d.Name); }
            foreach (var a in doc.Actions.Concat(doc.DataActions)) facts.Uses.Add(new Use(a, doc.Name + "." + a, "action", "actions"));
        }
        foreach (var e in text.Elements())
        {
            // An element id is a name of the owner and an alias of the job ($id) for the raw ops after it.
            if (e.Get("id") is { Length: > 0 } id && Regex.IsMatch(id, @"^[A-Za-z_]\w*$"))
            {
                facts.Declares.Add("$" + id); facts.Declares.Add(id);
                if (owner != null) facts.Declares.Add(owner + "." + id);
            }
            if (e.Tag == "block" && e.Get("name") is { Length: > 0 } block) facts.Uses.Add(new Use(block.Split('.').Last(), block.Contains('.') ? block : null, "block", null));
            foreach (var a in e.Attributes.Where(a => HtmlText.IsEvent(a.Name)))
            {
                var target = a.Value.Split('(')[0].Trim();
                if (Regex.IsMatch(target, @"^[A-Za-z_][\w.]*$")) facts.Uses.Add(new Use(target.Split('.').Last(), owner != null && !target.Contains('.') ? owner + "." + target : target, "handler", null));
            }
        }
    }

    private void Logic(JsonObject op, OpFacts facts)
    {
        if (op["data"] is not JsonObject data) return;
        foreach (var action in (data["actions"] as JsonArray ?? []).OfType<JsonObject>())
        {
            if (action["name"]?.ToString() is not { Length: > 0 } name) continue;
            var owner = OwnerName(JobFacts.Owner(action));
            facts.Declares.Add(name);
            if (owner != null) facts.Declares.Add(owner + "." + name);
            foreach (var call in LogicScan.Of(action).Calls) facts.Uses.Add(new Use(call.Target.Split('.', ':', '/').Last(), call.Target.Contains('.') ? call.Target : null, "call", null));
        }
        foreach (var (_, text) in DocumentNameRules.Texts(data))
        {
            foreach (Match header in FlowHeader.Matches(text))
            {
                var name = header.Groups[3].Value;
                var owner = header.Groups[2].Success ? header.Groups[2].Value.Split('/').Last() : null;
                facts.Declares.Add(name);
                if (owner != null) facts.Declares.Add(owner + "." + name);
            }
            foreach (var line in text.Replace("\r\n", "\n").Split('\n'))
            {
                var code = Literal.Replace(line.Split("//")[0], "\"\"");
                if (code.TrimStart().StartsWith("///", StringComparison.Ordinal) || FlowHeader.IsMatch(code)) continue;
                foreach (Match call in FlowCall.Matches(code))
                {
                    var callee = call.Groups[1].Value;
                    if (callee.StartsWith("(System)", StringComparison.Ordinal)) continue;
                    var last = callee.Split('.', '/').Last();
                    facts.Uses.Add(new Use(last, callee.Contains('.') || callee.Contains('/') ? callee : null, "call", null));
                }
            }
        }
    }

    /// <summary>The root names of an expression (no member, no call, no literal).</summary>
    internal static IEnumerable<string> RootNames(string expression)
    {
        List<Token> tokens;
        try { tokens = ExpressionText.Tokens(expression); } catch { yield break; }
        for (var k = 0; k < tokens.Count; k++)
        {
            if (!ExpressionText.IsRoot(tokens, k)) continue;
            if (k + 1 < tokens.Count && tokens[k + 1].Kind == TokenKind.Open) continue;
            if (tokens[k].Segments is [var root, ..] && root.Length > 0) yield return root;
        }
    }

    // ---- references -----------------------------------------------------------------------------------------------------

    private static bool LooksLikeReference(string value)
        => Regex.IsMatch(value, @"^(?:\$[\w.]+|@[\w+/=-]{8,}|I[A-Z]\w*:[^\s""]+)(?:/[^\s""]+)*$");

    /// <summary>The names a reference needs: its alias root, and each `Kind:Name` segment bare and under the one before.</summary>
    private void UseReference(string? reference, string kind, OpFacts facts)
    {
        if (string.IsNullOrEmpty(reference) || reference == "@espace") return;
        var segments = reference.Split('/');
        string? previous = null;
        foreach (var segment in segments)
        {
            if (segment.StartsWith('$')) { facts.Uses.Add(new Use(segment, null, "alias", kind)); previous = Aliases.TryGetValue(segment, out var e) ? e.Name ?? e.Owner : null; continue; }
            if (segment.StartsWith('@') || segment.StartsWith('#')) { previous = null; continue; }
            var colon = segment.IndexOf(':');
            var name = colon >= 0 ? segment[(colon + 1)..] : segment;
            if (name.Length == 0 || name.Contains('#')) continue;
            if (colon >= 0) facts.Uses.Add(new Use(name, previous != null ? previous + "." + name : null, "reference", kind));
            previous = name;
        }
    }

    private Element? ParentElement(string? reference)
    {
        if (string.IsNullOrEmpty(reference) || !reference.StartsWith('$')) return null;
        var root = reference.Split('/')[0];
        return Aliases.TryGetValue(root, out var element) ? element : null;
    }

    /// <summary>The screen or block a reference names first (`IMobileScreen:Home/...`), or the owner of its alias root.</summary>
    internal (string? Owner, string? Kind) OwnerOf(string? reference)
    {
        if (string.IsNullOrEmpty(reference)) return (null, null);
        if (ParentElement(reference) is { } element) return (element.Owner, element.OwnerKind);
        foreach (var segment in reference.Split('/'))
        {
            var colon = segment.IndexOf(':');
            if (colon <= 0) continue;
            var type = KindNames.Normalize(segment[..colon]);
            if (ScreenTypes.Contains(type)) return (segment[(colon + 1)..], "screen");
            if (BlockTypes.Contains(type)) return (segment[(colon + 1)..], "block");
        }
        return (null, null);
    }

    /// <summary>The producer a reference op names: its name, or the module of the capture it was bound to (a snapshot file
    /// `Name-20261013012848-ab12cd34.oml`, a download `Name.oml`, a frozen signature).</summary>
    internal static string ProducerName(string producer)
    {
        if (!producer.Contains('\\') && !producer.Contains('/') && !producer.EndsWith(".oml", StringComparison.OrdinalIgnoreCase) && !producer.EndsWith(".avsig", StringComparison.OrdinalIgnoreCase)) return producer;
        return Regex.Replace(Path.GetFileNameWithoutExtension(producer), @"-\d{14}(?:-[0-9a-f]+)?$", "");
    }

    /// <summary>The screen or block name of a logic owner (`IMobileScreen:Home`, `Home`), null for the module.</summary>
    internal static string? OwnerName(string? owner)
    {
        if (string.IsNullOrEmpty(owner) || owner == "@espace") return null;
        var last = owner.Split('/').Last();
        return last[(last.IndexOf(':') + 1)..];
    }

    // ---- what a refused op blocks ---------------------------------------------------------------------------------------

    /// <summary>The ops that use what <paramref name="refused"/> declare (directly, through an alias an op made from it, or the
    /// widget whose event a blocked op writes), each with the op that blocks it first and the names it misses.</summary>
    public Dictionary<int, (int Root, List<string> Names)> Blocked(IReadOnlyCollection<int> refused)
    {
        var blocked = new Dictionary<int, (int Root, List<string> Names)>();
        if (refused.Count == 0) return blocked;
        // A name is missing when every op that declares it is refused or blocked: the first root it comes from is kept. A name an
        // op that still builds declares too is not missing (the platform resolves it there).
        var declarers = new Dictionary<string, HashSet<int>>(StringComparer.OrdinalIgnoreCase);
        var declaredBy = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        foreach (var facts in Ops)
            foreach (var name in facts.Declares)
                if (refused.Contains(facts.Index)) declaredBy.TryAdd(name, facts.Index);
                else (declarers.TryGetValue(name, out var set) ? set : declarers[name] = []).Add(facts.Index);
        // The ops that need each name: an alias, a qualified name, or the bare name of a block or a reference segment.
        var users = new Dictionary<string, List<int>>(StringComparer.OrdinalIgnoreCase);
        foreach (var facts in Ops)
            foreach (var use in facts.Uses)
                if (use.Kind == "alias" || use.Qualified != null || use.Kind is "block" or "reference")
                    (users.TryGetValue(use.Qualified ?? use.Name, out var list) ? list : users[use.Qualified ?? use.Name] = []).Add(facts.Index);
        bool Missing(string name) => declaredBy.ContainsKey(name) && (!declarers.TryGetValue(name, out var live) || live.Count == 0);
        var pending = new Queue<string>(declaredBy.Keys.Where(Missing));
        while (pending.Count > 0)
        {
            var name = pending.Dequeue();
            foreach (var op in users.GetValueOrDefault(name) ?? [])
            {
                if (refused.Contains(op) || declaredBy[name] == op) continue;
                if (blocked.TryGetValue(op, out var already)) { if (!already.Names.Contains(name, StringComparer.OrdinalIgnoreCase)) already.Names.Add(name); continue; }
                var root = declaredBy[name];
                blocked[op] = (root, [name]);
                // What this op declares is missing too when no other op declares it, for the ops that need it.
                foreach (var declared in Ops[op].Declares)
                {
                    if (declarers.TryGetValue(declared, out var live)) live.Remove(op);
                    if (declaredBy.TryAdd(declared, root) && Missing(declared)) pending.Enqueue(declared);
                    else if (Missing(declared) && !pending.Contains(declared)) pending.Enqueue(declared);
                }
            }
        }
        // A blocked set of what an element reads from (its list, its destination, its variable) leaves the rest of that element
        // unbuildable: the arguments of an event without destination, the labels of a dropdown without list.
        var dependsOn = blocked.Keys.Select(i => Ops[i]).Where(f => f.Kind == "set").SelectMany(f => f.Uses.Where(u => u.Kind == "alias" && u.At == "target")
            .Select(u => (Target: Targets.GetValueOrDefault(f.Index), Root: blocked[f.Index]))).Where(x => x.Target != null).ToList();
        foreach (var facts in Ops)
        {
            if (blocked.ContainsKey(facts.Index) || refused.Contains(facts.Index) || !Targets.TryGetValue(facts.Index, out var target)) continue;
            foreach (var (blockedTarget, why) in dependsOn)
                if (target == blockedTarget || target.StartsWith(blockedTarget + "/", StringComparison.Ordinal)) { blocked[facts.Index] = why; break; }
        }
        // The Verify speaks of the widget whose event a blocked set writes (On Click must be set): its create op goes with it.
        foreach (var (op, why) in blocked.ToList())
            foreach (var use in Ops[op].Uses.Where(u => u.Kind == "alias" && u.At == "target"))
                if (Aliases.TryGetValue(use.Name, out var element) && !blocked.ContainsKey(element.Op) && !refused.Contains(element.Op)) blocked[element.Op] = (why.Root, why.Names);
        return blocked;
    }
}
