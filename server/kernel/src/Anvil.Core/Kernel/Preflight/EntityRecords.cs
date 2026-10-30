using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core.Preflight;

/// <summary>
/// R2-C (normalizations, 2026-10-29), KERNEL K8 `Get&lt;E&gt;.Record.Attr`: the Record that the entity action Get&lt;E&gt; (and
/// Get&lt;E&gt;ForUpdate) gives is a record of one member, the entity E: its attributes are read Get.Record.E.Attr. That is the form
/// the kernel itself writes for a `load` of the general language in both lanes (FlowGeneral.RecordLine, proven by the apply of
/// FlowApplyScenarios in O11 and ODC), and the Verify refused the other one only after the whole build (O11
/// InvalidVariable_UnknownObjInVar / ExpressionUnknownObject, "Unknown object 'N.Record.Balance'"). `N.Record.Attr`, where the
/// node N calls Get&lt;E&gt;[ForUpdate] and Attr is an attribute of E (and not E itself), has one reading: written N.Record.E.Attr and
/// listed (RECORD_ENTITY_MEMBER_ADDED), in every expression of the action, JSON logic and logic text alike.
/// <para>Only when it is certain: E is a server entity the job or the base declares (its identifier attribute says so: a
/// structure has no Get), the call can only be the entity action (the caller runs on the server, as a server, service or data
/// action: a client or screen action never calls it; no action of the job and no action of the module, of any kind, has that
/// name; the base, when it resolves the callee, says it is the entity's action with its one output Record), Attr is one of E's
/// attributes, and E has no attribute named E (then N.Record.E is two things). In a logic text a node name counts only in its
/// own action. A node of another kind, an attribute E does not have, or an entity this side does not know is left as written:
/// the Verify says what it is.</para>
/// </summary>
public static class EntityRecords
{
    public const string Rule = "RECORD_ENTITY_MEMBER_ADDED";

    // A call node of a logic text: `Name = Target(...)`.
    private static readonly Regex CallLine = new(@"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(", RegexOptions.Compiled);

    public static void Normalize(JsonArray ops, string? prefix, IBaseFacts? model, List<JsonObject> done)
    {
        JobFacts job;
        try { job = JobFacts.From(ops); } catch { return; }
        var declared = new HashSet<string>(job.Actions.Select(a => a.Name), StringComparer.OrdinalIgnoreCase);
        foreach (var op in ops.OfType<JsonObject>())
            if (op["op"]?.ToString() == "logic" && op["data"] is JsonObject data && data.ContainsKey("flow"))
                try { declared.UnionWith(FlowTextForm.ActionNames(FlowTextForm.Texts(data))); } catch { }
        // The entities (and static entities) the specs of the job declare: a Get of theirs is an entity action.
        var jobEntities = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var op in ops.OfType<JsonObject>())
            if (op["op"]?.ToString() == "spec" && op["data"] is JsonObject spec)
                try
                {
                    var sections = SpecExpander.Sections(spec);
                    foreach (var section in new[] { "entities", "clientEntities", "static" })
                        foreach (var record in (sections[section] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
                            if (record["name"]?.ToString() is { Length: > 0 } entity) jobEntities.Add(entity);
                }
                catch { }
        var entities = new Dictionary<string, (string Entity, IReadOnlyDictionary<string, string> Attributes)?>(StringComparer.OrdinalIgnoreCase);
        (string Entity, IReadOnlyDictionary<string, string> Attributes)? EntityOf(string target, JsonObject caller)
        {
            var memo = target + "|" + caller["kind"] + "|" + caller["name"];
            if (entities.TryGetValue(memo, out var known)) return known;
            return entities[memo] = Resolve(target, caller, job, jobEntities, model, declared);
        }
        foreach (var action in job.Actions)
        {
            // The entity action of a server entity runs on the server: a client or screen action never calls it.
            if (!ServerSide(action.Kind)) continue;
            LogicScan scan;
            try { scan = LogicScan.Of(action.Declaration); } catch { continue; }
            var loads = new Dictionary<string, (string Entity, IReadOnlyDictionary<string, string> Attributes)>(StringComparer.OrdinalIgnoreCase);
            foreach (var node in scan.Nodes.Values)
                if (node.Kind == "call" && node.Target is { } target && EntityOf(target, action.Declaration) is { } entity) loads[node.Name] = entity;
            if (loads.Count == 0) continue;
            foreach (var site in scan.Expressions)
            {
                if (Rewrite(site.Text, loads) is not { } rewritten || !ExpressionRewrites.Write(action.Declaration, site.Pointer, site.Text, rewritten.Text)) continue;
                done.Add(JobNormalizer.Entry(Rule, prefix == null ? null : $"{prefix}/{action.Op}/data/actions/{action.Index}{site.Pointer}", site.Text, rewritten.Text, rewritten.Message));
            }
        }
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "logic" || op["data"] is not JsonObject data || !data.ContainsKey("flow")) continue;
            FlowTexts.Rewrite(data, prefix == null ? null : $"{prefix}/{i}", (text, path) => Text(text, path, EntityOf, done));
        }
    }

    /// <summary>A caller that runs on the server (a server, service or data action): the only ones an entity action of a server
    /// entity can be called from.</summary>
    private static bool ServerSide(string? kind) => kind?.ToLowerInvariant() is "server" or "service" or "data";

    /// <summary>The entity whose entity action <paramref name="target"/> is (GetE, GetEForUpdate) when called from
    /// <paramref name="caller"/>, with its attributes; null when that is not certain: the call can only be that entity action
    /// when no action of the job and no action of the module, of any kind, has the name, and the base, when it resolves the
    /// callee, says it is the entity's action.</summary>
    private static (string Entity, IReadOnlyDictionary<string, string> Attributes)? Resolve(string target, JsonObject caller, JobFacts job, HashSet<string> jobEntities, IBaseFacts? model, HashSet<string> declared)
    {
        var name = target.Trim();
        if (name.Contains(':') || name.Contains('.') || !name.StartsWith("Get", StringComparison.Ordinal) || name.Length <= 3) return null;
        // An action of the job or of the module named so (server, service or client) is the callee, not the entity action.
        if (declared.Contains(name)) return null;
        if (model != null && new[] { "ServerAction", "ServiceAction", "ClientAction" }.Any(kind => model.OwnAction(name, kind) != null)) return null;
        var rest = name[3..];
        var candidates = new List<string> { rest };
        if (rest.EndsWith("ForUpdate", StringComparison.Ordinal) && rest.Length > "ForUpdate".Length) candidates.Add(rest[..^"ForUpdate".Length]);
        var hits = new List<(string, IReadOnlyDictionary<string, string>)>();
        foreach (var candidate in candidates)
        {
            IReadOnlyDictionary<string, string>? attributes = job.Records.TryGetValue(candidate, out var own) ? own : model?.Attributes(candidate);
            // An entity (or a static entity): a spec of the job declares it so, or its identifier is of its own Identifier type
            // (the base). A structure has none, and no Get.
            if (attributes == null || !(job.Records.ContainsKey(candidate) ? jobEntities.Contains(candidate)
                : attributes.Values.Any(t => string.Equals(t?.Trim(), candidate + " Identifier", StringComparison.OrdinalIgnoreCase)))) continue;
            // A client (local storage) entity has its actions on the client side: not this form.
            if (job.ClientEntities.Contains(candidate) || model?.IsClientEntity(candidate) == true) continue;
            hits.Add((candidate, attributes));
        }
        if (hits.Count != 1) return null;
        if (model != null)
        {
            // The base names the element of that name in the action scope: it must be the entity's own action.
            foreach (var scope in new[] { "server", "client" })
                if (model.ActionNameTaken(name, scope) is { } taken && !string.Equals(taken.Owner, hits[0].Item1, StringComparison.OrdinalIgnoreCase)) return null;
            // The callee the base resolves: an entity action Get has one output, Record.
            if (model.Callee(name, caller) is { } callee && !(callee.Outputs.Count == 1 && string.Equals(callee.Outputs[0].Name, "Record", StringComparison.OrdinalIgnoreCase))) return null;
        }
        return hits[0];
    }

    private sealed record Rewritten(string Text, string Message);

    /// <summary>The expression with every N.Record.Attr of a load node written N.Record.E.Attr, or null when it has none.</summary>
    private static Rewritten? Rewrite(string text, IReadOnlyDictionary<string, (string Entity, IReadOnlyDictionary<string, string> Attributes)> loads)
    {
        if (!text.Contains(".Record.", StringComparison.OrdinalIgnoreCase)) return null;
        List<Token> tokens;
        try { tokens = ExpressionText.Tokens(text); } catch { return null; }
        var edits = new List<(int Start, int Length, string Text)>();
        var said = new List<string>();
        foreach (var t in tokens)
        {
            if (t.Kind != TokenKind.Name || t.Text.StartsWith('.')) continue;
            var parts = t.Segments;
            if (parts.Length < 3 || !parts[1].Equals("Record", StringComparison.OrdinalIgnoreCase) || !loads.TryGetValue(parts[0], out var load)) continue;
            var (entity, attributes) = load;
            var member = parts[2];
            if (member.Equals(entity, StringComparison.OrdinalIgnoreCase) || attributes.ContainsKey(entity) || !attributes.ContainsKey(member)) continue;
            var written = string.Join(".", new[] { parts[0], parts[1], entity }.Concat(parts.Skip(2)));
            edits.Add((t.Start, t.Text.Length, written));
            said.Add($"{t.Text} is {written}");
        }
        if (edits.Count == 0) return null;
        foreach (var (start, length, written) in edits.OrderByDescending(e => e.Start)) text = text[..start] + written + text[(start + length)..];
        var entities = loads.Values.Select(l => l.Entity).Distinct(StringComparer.OrdinalIgnoreCase);
        return new Rewritten(text, $"the Record of an entity action Get<E> holds one member, the entity ({string.Join(", ", entities.Select(e => "Get" + e + ".Record." + e))}): {string.Join("; ", said.Distinct(StringComparer.Ordinal))}");
    }

    // The header of an action of a logic text: its kind and name (server action X, service action X, data action S.X, client
    // action X, action S.X for a screen action).
    private static readonly Regex Header = new(@"^(?:(server|service|data|client|screen)\s+)?action\s+([A-Za-z_][A-Za-z0-9_./]*)", RegexOptions.Compiled);

    // A logic text, one action at a time (from its header, a line at the margin, to the next line at the margin), as the JSON
    // path does: in an action that runs on the server, its call nodes of an entity action (each line `N = GetE(...)`), then
    // every N.Record.Attr of its lines. A node name means nothing in another action of the same text.
    private static string? Text(string text, string? path, Func<string, JsonObject, (string Entity, IReadOnlyDictionary<string, string> Attributes)?> entityOf, List<JsonObject> done)
    {
        if (!text.Contains(".Record.", StringComparison.OrdinalIgnoreCase)) return null;
        var lines = text.Split('\n');
        var changed = false;
        static bool Margin(string line) => line.Length > 0 && !char.IsWhiteSpace(line[0]) && !line.StartsWith("//", StringComparison.Ordinal);
        for (var start = 0; start < lines.Length; start++)
        {
            if (!Margin(lines[start])) continue;
            var end = start + 1;
            while (end < lines.Length && !Margin(lines[end])) end++;
            var header = Header.Match(lines[start].Trim());
            var kind = header.Success ? (header.Groups[1].Success ? header.Groups[1].Value : "screen") : null;
            if (kind != null && ServerSide(kind))
            {
                var caller = new JsonObject { ["name"] = header.Groups[2].Value, ["kind"] = kind };
                var loads = new Dictionary<string, (string Entity, IReadOnlyDictionary<string, string> Attributes)>(StringComparer.OrdinalIgnoreCase);
                for (var n = start + 1; n < end; n++)
                    if (CallLine.Match(lines[n]) is { Success: true } call && entityOf(call.Groups[2].Value, caller) is { } entity) loads[call.Groups[1].Value] = entity;
                if (loads.Count > 0)
                    for (var n = start + 1; n < end; n++)
                    {
                        var content = lines[n].TrimStart();
                        if (content.StartsWith("//", StringComparison.Ordinal) || content.StartsWith('|') || content.StartsWith("@{", StringComparison.Ordinal)) continue;
                        if (Rewrite(lines[n], loads) is not { } rewritten) continue;
                        var entry = JobNormalizer.Entry(Rule, path, $"line {n + 1}: {lines[n].Trim()}", rewritten.Text.Trim(), $"line {n + 1}: {rewritten.Message}");
                        entry["line"] = n + 1;
                        done.Add(entry);
                        lines[n] = rewritten.Text;
                        changed = true;
                    }
            }
            start = end - 1;
        }
        return changed ? string.Join('\n', lines) : null;
    }
}
