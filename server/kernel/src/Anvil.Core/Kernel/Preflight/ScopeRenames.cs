using System.Text.Json.Nodes;

namespace Anvil.Core.Preflight;

/// <summary>
/// motor2 (2026-10-12), class C09 of the refusals found only at apply (NAME_COLLISION, 32 rounds; FolhaPonto_UI 13:58:12:
/// the output Resumo of the data action CarregarHoje and the variable Resumo of the screen BaterPonto). A screen (or block)
/// is one scope with its data actions and screen actions: the Studio renames a parameter of one of them that has the name of
/// a variable, input, aggregate or data action of the screen (Resumo becomes Resumo2) and every expression that names it then
/// reads the other element. Decided here, before the apply, from the screen's document in the job (ScreenDocFacts) and,
/// with the base, from the screen the module already has:
/// <list type="bullet">
/// <item>PARAMETER_RENAMED (normalization): the newcomer is renamed as the Studio would (the first free Name2) and every
/// reference of the job is rewritten with it: an output or local of a data action (its assignments in its own body; outside,
/// DataAction.Name in the screen's actions, each expression of its document element by element, and the sets on an
/// element of that screen), an input of a screen action (what its body reads, the named arguments of the calls and the
/// names of the top-level arguments of the events of the document that call it), a local of a screen action (its body).
/// Inside the action that declares it the name means the declaration (the scope rule of the language; an input is never
/// assigned, so an assignment to the name is the screen's variable and stays). A renamed assignment or argument key is
/// marked for <see cref="SentJob"/>.</item>
/// <item>NAME_COLLISION (refusal, no patch): an output of a data action whose body also reads the screen's element of that
/// name (two meanings in one body), or read by a `set` on an element whose screen the job does not say; never rewritten.</item>
/// </list>
/// </summary>
public static class ScopeRenames
{
    public const string Rule = "PARAMETER_RENAMED";

    /// <summary>The names of a screen of the base (its inputs, local variables, aggregates, data actions and screen actions),
    /// for a screen the job does not create; null when the base does not have it (or there is no base).</summary>
    public delegate IReadOnlyCollection<string>? ScreenNames(string owner);

    private sealed record Scope(string Owner, ScreenDocFacts? Doc, IReadOnlyDictionary<string, string> Names);

    private sealed record Rename(ActionFact Action, string Section, ParamFact Parameter, string To, Scope Scope, string Against);

    public static void Normalize(JsonArray ops, string? prefix, string lane, ScreenNames? baseScreen, List<JsonObject> done)
    {
        try { Run(ops, prefix, baseScreen, done, null); }
        catch { /* a normalization never refuses: the checks and the apply judge what stays */ }
    }

    public static List<JsonObject> Check(JsonArray ops, string? prefix, ScreenNames? baseScreen)
    {
        var problems = new List<JsonObject>();
        try { Run(ops, prefix, baseScreen, null, problems); }
        catch { }
        return problems;
    }

    private static void Run(JsonArray ops, string? prefix, ScreenNames? baseScreen, List<JsonObject>? done, List<JsonObject>? problems)
    {
        var job = JobFacts.From(ops);
        var docs = ScreenDocFacts.All(ops);
        var created = RawScreens(ops);
        var scopes = new Dictionary<string, Scope>(StringComparer.OrdinalIgnoreCase);
        foreach (var action in job.Actions.Where(a => a.Owner != "@espace" && a.Kind is "screen" or "data"))
        {
            if (scopes.ContainsKey(action.Owner)) continue;
            var names = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var doc = docs.FirstOrDefault(d => d.Owns(action.Owner));
            var screenName = action.Owner[(action.Owner.IndexOf(':') + 1)..];
            if (doc != null) foreach (var (name, what) in doc.Names()) names.TryAdd(name, what);
            else if (created.TryGetValue(screenName, out var raw)) foreach (var (name, what) in raw) names.TryAdd(name, what);
            else if (baseScreen?.Invoke(action.Owner) is { } existing) foreach (var name in existing) names.TryAdd(name, "element");
            else continue;
            // The screen's actions and data actions this job declares are names of the scope too.
            foreach (var other in job.Actions.Where(a => string.Equals(a.Owner, action.Owner, StringComparison.OrdinalIgnoreCase)))
                names.TryAdd(other.Name, other.Kind == "data" ? "data action" : "screen action");
            scopes[action.Owner] = new Scope(action.Owner, doc, names);
        }
        if (scopes.Count == 0) return;
        var renames = new List<Rename>();
        foreach (var action in job.Actions)
        {
            if (!scopes.TryGetValue(action.Owner, out var scope)) continue;
            IEnumerable<(string Section, ParamFact P)> candidates = action.Kind == "data"
                ? action.Outputs.Select(p => ("outputs", p)).Concat(action.Vars.Select(p => ("vars", p)))
                : action.Kind == "screen" ? action.Inputs.Select(p => ("inputs", p)).Concat(action.Vars.Select(p => ("vars", p))) : [];
            var own = action.Locals.Select(p => p.Name).Append(action.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
            foreach (var (section, p) in candidates)
            {
                if (!scope.Names.TryGetValue(p.Name, out var what) || string.Equals(p.Name, action.Name, StringComparison.OrdinalIgnoreCase)) continue;
                // A screen action or data action of the scope with the name of a parameter is another scope rule (the action's
                // name is a root of its own body): only data of the screen is judged here.
                if (what is "screen action") continue;
                var taken = scope.Names.Keys.Concat(own).Concat(renames.Where(r => r.Scope == scope).Select(r => r.To));
                renames.Add(new Rename(action, section, p, NameRules.Free(p.Name, taken), scope, $"{what} {scope.Names.Keys.First(k => k.Equals(p.Name, StringComparison.OrdinalIgnoreCase))}"));
            }
        }
        foreach (var rename in renames)
        {
            var action = rename.Action; var p = rename.Parameter;
            var at = prefix == null ? null : $"{prefix}/{action.Op}/data/actions/{action.Index}/{rename.Section}/{p.Index}/name";
            var screen = rename.Scope.Owner[(rename.Scope.Owner.IndexOf(':') + 1)..];
            var what = rename.Section switch { "outputs" => "output", "inputs" => "input", _ => "local variable" };
            // An input of a screen action an event calls by its bare name (@OnPick='X', onclick="X", a `set` of its Handler or
            // Destination) receives the event's parameter of the same name: renamed, it would receive nothing (a client module, 30cb7c99,
            // ArgumentRequiredExpression on CaseId2). The name is the event's; refused.
            if (action.Kind == "screen" && rename.Section == "inputs" && BoundByName(ops, action) is { } binding)
            {
                problems?.Add(JobPreflight.Problem(action.Op, at, "NAME_COLLISION", "error",
                    $"input '{p.Name}' of screen action {action.Name} has the name of the {rename.Against} of {screen} (one scope: the Studio renames it to {rename.To}), and {binding} calls {action.Name} by name, which passes its parameter '{p.Name}' to the input of that name",
                    $"rename the screen's {rename.Against} (and what reads it), or call {action.Name}({rename.To} = <the event's {p.Name}>) with the input renamed", null, "logic"));
                continue;
            }
            // An output (or local) of a data action whose body reads the name has two meanings in one body: refused, without a
            // patch (renaming the declaration alone would leave its assignments writing the screen's element).
            if (action.Kind == "data" && ReadsInBody(action, p.Name))
            {
                problems?.Add(JobPreflight.Problem(action.Op, at, "NAME_COLLISION", "error",
                    $"{what} '{p.Name}' of data action {action.Name} has the name of the {rename.Against} of {screen} (one scope: the Studio renames it to {rename.To}), and the body of {action.Name} also reads '{p.Name}'",
                    $"rename the {what} to {rename.To}, with the assignments of the body that mean it, and write {action.Name}.{rename.To} where the screen reads it; keep '{p.Name}' where the body means the screen's {rename.Against}",
                    null, "logic"));
                continue;
            }
            // A raw `set` that reads DataAction.Output on an element whose screen the job does not say (an alias it does not
            // create there, a key): the output may be another screen's (each screen has its own data actions). Refused.
            if (action.Kind == "data" && rename.Section == "outputs" && UnknownOwnerSets(ops, action, p.Name, rename.To) is { Count: > 0 } unknown)
            {
                problems?.Add(JobPreflight.Problem(action.Op, at, "NAME_COLLISION", "error",
                    $"{what} '{p.Name}' of data action {action.Name} has the name of the {rename.Against} of {screen} (one scope: the Studio renames it to {rename.To}), and {string.Join(", ", unknown.Select(u => $"op #{u}"))} (set) reads {action.Name}.{p.Name} on an element whose screen the job does not say, so which screen's {action.Name} it reads is not certain",
                    $"rename the {what} to {rename.To} and write {action.Name}.{rename.To} where {screen} reads it; write the set's target with its screen ({rename.Scope.Owner}/<Widget>) so the kernel renames it for you",
                    null, "logic"));
                continue;
            }
            if (done == null) continue;
            var uses = Apply(ops, job, rename, prefix);
            done.Add(JobNormalizer.Entry(Rule, at, p.Name, rename.To,
                $"{what} '{p.Name}' of {(action.Kind == "data" ? "data action" : "screen action")} {action.Name} has the name of the {rename.Against} of {screen} (one scope): renamed {rename.To}, as the Studio would, with its {uses} reference(s) in the job"));
        }
    }

    private static readonly Dictionary<string, string> RawData = new(StringComparer.Ordinal)
    {
        ["IInputParameter"] = "input", ["ILocalVariable"] = "variable", ["IAggregate"] = "aggregate", ["IScreenAggregate"] = "aggregate", ["IDataAction"] = "data action",
    };

    /// <summary>The screens and blocks the job creates with raw ops (`create IMobileScreen ... as $s`, then its inputs, local
    /// variables, aggregates and data actions with parent `$s`), by name: their data names.</summary>
    private static Dictionary<string, List<(string Name, string What)>> RawScreens(JsonArray ops)
    {
        var byAlias = new Dictionary<string, string>(StringComparer.Ordinal);
        var screens = new Dictionary<string, List<(string, string)>>(StringComparer.OrdinalIgnoreCase);
        foreach (var op in ops.OfType<JsonObject>())
        {
            if (op["op"]?.ToString() != "create" || op["type"]?.ToString()?.Split('.').Last() is not { } type || op["name"]?.ToString() is not { Length: > 0 } name) continue;
            if (type.EndsWith("Screen", StringComparison.Ordinal) || type.EndsWith("Block", StringComparison.Ordinal))
            {
                screens.TryAdd(name, []);
                if (op["as"]?.ToString() is { Length: > 0 } alias) { byAlias[alias] = name; if (ModelSession.AliasCounterpart(alias) is { } other) byAlias[other] = name; }
                continue;
            }
            if (!RawData.TryGetValue(type, out var what) || op["parent"]?.ToString() is not { Length: > 0 } parent) continue;
            var owner = byAlias.TryGetValue(parent, out var aliased) ? aliased
                : parent.IndexOf(':') is var colon and > 0 && (parent[..colon].EndsWith("Screen", StringComparison.Ordinal) || parent[..colon].EndsWith("Block", StringComparison.Ordinal)) && !parent.Contains('/') ? parent[(colon + 1)..] : null;
            if (owner != null && screens.TryGetValue(owner, out var list)) list.Add((name, what));
        }
        return screens;
    }

    /// <summary>Where an event calls the screen action by its bare name (its arguments then come by name): an html event
    /// attribute (on*, @*) whose value is the name alone, or a `set` of Handler/Destination whose value names it; null when none.</summary>
    private static string? BoundByName(JsonArray ops, ActionFact action)
    {
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op) continue;
            var kind = op["op"]?.ToString();
            if (kind == "set" && op["prop"]?.ToString() is "Handler" or "Destination" && op["value"]?.ToString() is { } value
                && (value.Equals(action.Name, StringComparison.OrdinalIgnoreCase) || value.EndsWith("/" + action.Name, StringComparison.OrdinalIgnoreCase)
                    || value.EndsWith(":" + action.Name, StringComparison.OrdinalIgnoreCase)))
                return $"op #{i} (set {op["prop"]})";
            if (kind != "html") continue;
            foreach (var html in new[] { op["data"]?["html"], op["html"] }.OfType<JsonValue>().Select(v => v.TryGetValue<string>(out var s) ? s : null).OfType<string>())
                foreach (var element in HtmlText.Parse(html).Elements())
                    foreach (var a in element.Attributes)
                        if ((a.Name.StartsWith("on", StringComparison.OrdinalIgnoreCase) || a.Name.StartsWith('@')) && HtmlDocumentRules.Decode(a.Value).Trim().Equals(action.Name, StringComparison.OrdinalIgnoreCase))
                            return $"op #{i} ({a.Name}='{a.Value}')";
        }
        return null;
    }

    private static bool ReadsInBody(ActionFact action, string name)
    {
        var scan = LogicScan.Of(action.Declaration);
        return scan.Expressions.Any(e => HtmlText.ReadsRoot(e.Text, name));
    }

    /// <summary>The screen or block (`IMobileScreen:Name`) a raw reference is on: its head when it names one, or the screen
    /// the job creates the alias it starts with under; null when the reference does not say (a key, an element of another
    /// kind, an alias the job does not create under a screen).</summary>
    private static string? OwnerOf(string reference, IReadOnlyDictionary<string, string?> aliases)
    {
        var head = reference.Split('/')[0].Trim();
        if (head.StartsWith('$')) return aliases.TryGetValue(head, out var owner) ? owner : null;
        var colon = head.IndexOf(':');
        if (colon <= 0) return null;
        var kind = head[..colon];
        return kind.EndsWith("Screen", StringComparison.Ordinal) || kind.EndsWith("Block", StringComparison.Ordinal) ? head : null;
    }

    /// <summary>The screen of each alias the job creates: a screen or block it creates, or what it creates under one.</summary>
    private static Dictionary<string, string?> AliasOwners(JsonArray ops)
    {
        var aliases = new Dictionary<string, string?>(StringComparer.Ordinal);
        foreach (var op in ops.OfType<JsonObject>())
        {
            if (op["op"]?.ToString() != "create" || op["as"]?.ToString() is not { Length: > 0 } alias) continue;
            var type = op["type"]?.ToString()?.Split('.').Last() ?? "";
            aliases[alias] = (type.EndsWith("Screen", StringComparison.Ordinal) || type.EndsWith("Block", StringComparison.Ordinal)) && op["name"]?.ToString() is { Length: > 0 } name
                ? $"{type}:{name}" : op["parent"]?.ToString() is { Length: > 0 } parent ? OwnerOf(parent, aliases) : null;
        }
        return aliases;
    }

    /// <summary>Two owners name the same screen (or block): the same name, both screens or both blocks.</summary>
    private static bool SameOwner(string a, string b)
    {
        int ca = a.IndexOf(':'), cb = b.IndexOf(':');
        if (ca <= 0 || cb <= 0 || !a[(ca + 1)..].Equals(b[(cb + 1)..], StringComparison.OrdinalIgnoreCase)) return false;
        return a[..ca].EndsWith("Block", StringComparison.Ordinal) == b[..cb].EndsWith("Block", StringComparison.Ordinal);
    }

    /// <summary>The raw `set` ops whose value reads Action.Output on an element of the action's screen (rewritten with the
    /// rename) and those on an element whose screen the job does not say (not certain).</summary>
    private static (List<int> Own, List<int> Unknown) SetsReading(JsonArray ops, ActionFact action, string from, string to)
    {
        var aliases = AliasOwners(ops);
        var own = new List<int>(); var unknown = new List<int>();
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject set || set["op"]?.ToString() != "set" || set["value"] is not JsonValue sv || !sv.TryGetValue<string>(out var text)
                || HtmlText.WithMember(text, action.Name, from, to) == text) continue;
            var owner = set["target"]?.ToString() is { } target ? OwnerOf(target, aliases) : null;
            if (owner == null) unknown.Add(i);
            else if (SameOwner(owner, action.Owner)) own.Add(i);
        }
        return (own, unknown);
    }

    private static List<int> UnknownOwnerSets(JsonArray ops, ActionFact action, string from, string to) => SetsReading(ops, action, from, to).Unknown;

    /// <summary>Renames the parameter and every reference the job makes to it; returns how many references changed.</summary>
    private static int Apply(JsonArray ops, JobFacts job, Rename rename, string? prefix)
    {
        var action = rename.Action; var from = rename.Parameter.Name; var to = rename.To;
        var count = 0;
        // The declaration.
        if (action.Declaration[rename.Section] is JsonArray list && rename.Parameter.Index < list.Count && list[rename.Parameter.Index] is JsonObject declared)
            declared["name"] = to;
        var scan = LogicScan.Of(action.Declaration);
        // The body: what it reads by the name (never for... nothing else of the body can mean the screen's element: an input
        // is not assigned, an output or local is the declaration).
        foreach (var site in scan.Expressions)
        {
            var written = HtmlText.WithRoot(site.Text, from, to);
            if (written != site.Text && ExpressionRewrites.Write(action.Declaration, site.Pointer, site.Text, written)) count++;
        }
        // The assignments: an output or local is assigned by its name; an input is never assigned (that name is the screen's).
        if (rename.Section != "inputs")
            foreach (var (step, _) in scan.Steps)
                if (step["assign"] is JsonObject pairs && pairs.Select(kv => kv.Key).FirstOrDefault(k => k.Equals(from, StringComparison.OrdinalIgnoreCase)) is { } key)
                {
                    var value = pairs[key]?.DeepClone();
                    var ordered = pairs.ToList().Select(kv => (kv.Key == key ? to : kv.Key, kv.Key == key ? value : kv.Value?.DeepClone())).ToList();
                    pairs.Clear();
                    foreach (var (k, v) in ordered) pairs[k] = v;
                    SentJob.KeyRenamed(pairs, key, to);
                    count++;
                }
        var owner = action.Owner;
        if (action.Kind == "data" && rename.Section == "outputs")
        {
            // Outside: DataAction.Output in the screen's other actions, the screen's document and the sets of the job.
            foreach (var other in job.Actions.Where(a => !ReferenceEquals(a, action) && string.Equals(a.Owner, owner, StringComparison.OrdinalIgnoreCase)))
                foreach (var site in LogicScan.Of(other.Declaration).Expressions)
                {
                    var written = HtmlText.WithMember(site.Text, action.Name, from, to);
                    if (written != site.Text && ExpressionRewrites.Write(other.Declaration, site.Pointer, site.Text, written)) count++;
                }
            if (rename.Scope.Doc is { } doc && ops[doc.Op] is JsonObject op && op["data"] is JsonObject data && data["html"] is JsonValue hv && hv.TryGetValue<string>(out var html))
            {
                // Each expression of each element (an attribute's value, the {{ }} of a text attribute and of the texts, the
                // argument expressions of an event): never the whole text, whose attribute quotes are no literal of the language.
                var text = HtmlText.Parse(html);
                var edits = text.Elements().SelectMany(e => HtmlText.ExpressionSpans(html, e))
                    .SelectMany(s => HtmlText.RenameMember(html, s.Start, s.End, action.Name, from, to)).DistinctBy(e => (e.Start, e.Length)).ToList();
                if (edits.Count > 0) { SentJob.HtmlBefore(data, html); data["html"] = HtmlText.Apply(html, edits); count += edits.Count; }
            }
            // Only the sets on an element of this screen (Run refused the rename when a set's screen is not said).
            foreach (var i in SetsReading(ops, action, from, to).Own)
                if (ops[i] is JsonObject set && set["value"] is JsonValue sv && sv.TryGetValue<string>(out var text))
                { set["value"] = HtmlText.WithMember(text, action.Name, from, to); count++; }
        }
        if (action.Kind == "screen" && rename.Section == "inputs")
        {
            // The named arguments of the calls to it: logic calls of the job, and the events of the document that call it.
            foreach (var caller in job.Actions)
                foreach (var call in LogicScan.Of(caller.Declaration).Calls)
                {
                    if (!CallsScreenAction(call.Target, action, caller) || call.Step["args"] is not JsonObject args) continue;
                    if (args.Select(kv => kv.Key).FirstOrDefault(k => k.Equals(from, StringComparison.OrdinalIgnoreCase)) is not { } key) continue;
                    var ordered = args.ToList().Select(kv => (kv.Key == key ? to : kv.Key, kv.Value?.DeepClone())).ToList();
                    args.Clear();
                    foreach (var (k, v) in ordered) args[k] = v;
                    SentJob.KeyRenamed(args, key, to);
                    count++;
                }
            if (rename.Scope.Doc is { } doc && ops[doc.Op] is JsonObject op && op["data"] is JsonObject data && data["html"] is JsonValue hv && hv.TryGetValue<string>(out var html))
            {
                var edits = EventArguments(html, action.Name, from, to);
                if (edits.Count > 0) { SentJob.HtmlBefore(data, html); data["html"] = HtmlText.Apply(html, edits); count += edits.Count; }
            }
        }
        return count;
    }

    private static bool CallsScreenAction(string target, ActionFact callee, ActionFact caller)
    {
        if (!string.Equals(caller.Owner, callee.Owner, StringComparison.OrdinalIgnoreCase)) return false;
        var name = target.Contains('/') ? target[(target.LastIndexOf('/') + 1)..] : target.Contains(':') ? target[(target.IndexOf(':') + 1)..] : target;
        return string.Equals(name, callee.Name, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>The edits of `Action(Name = ...)` in the event attributes (on*, @*) of a document: the name of the argument of
    /// the call's top level renamed, never a name inside an argument's expression (`If(Filtro = "", ...)` is the screen's).</summary>
    private static List<HtmlText.Edit> EventArguments(string html, string action, string from, string to)
    {
        var edits = new List<HtmlText.Edit>();
        var text = HtmlText.Parse(html);
        var call = new System.Text.RegularExpressions.Regex(@"^\s*" + System.Text.RegularExpressions.Regex.Escape(action) + @"\s*\(", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        foreach (var element in text.Elements())
            foreach (var a in element.Attributes.Where(a => HtmlText.IsEvent(a.Name)))
            {
                if (!call.IsMatch(a.Value) || HtmlText.CallArguments(a.Value) is not { } arguments) continue;
                foreach (var argument in arguments)
                    if (argument.Name != null && argument.Name.Equals(from, StringComparison.OrdinalIgnoreCase))
                        edits.Add(new(a.ValueStart + argument.NameStart, argument.Name.Length, to));
            }
        return edits;
    }
}
