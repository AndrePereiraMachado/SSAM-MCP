using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;

namespace Anvil.Core.Preflight;

/// <summary>A new module action shares the native namespace of module, entity and imported actions. Decide before
/// apply, even when a reference op is present or the body of a text action has another problem.</summary>
public static class ActionNameRules
{
    public const string Fix = "give the new action another name (the patch uses the Studio's free name; a public action's name is its API: send the same patch with the name you want), or call the existing element instead";
    private sealed record Declaration(int Op, string Pointer, string Name, JsonObject Caller, IReadOnlyList<ParamFact> Inputs,
        string Scope, int JsonIndex = -1, int TextIndex = -1);
    private sealed record Rename(Declaration Action, ActionNameFact Taken, string Name, CalleeFact? Existing);
    internal static string Scope(string? kind) => kind?.Contains("client", StringComparison.OrdinalIgnoreCase) is true ? "client" : "server";
    private static string ScopedName(string scope, string name) => scope + ":" + name;

    public static List<JsonObject> Check(JsonArray ops, string? prefix, IBaseFacts? model)
    {
        var declared = Declarations(ops).ToList();
        var pure = ImportedNames(ops);
        var occupiedByScope = new[] { "server", "client" }.ToDictionary(scope => scope,
            scope => pure.Values.Where(p => p.Scope == scope).Select(p => p.Name).Concat(declared.Where(d => d.Scope == scope).Select(d => d.Name)).ToHashSet(StringComparer.OrdinalIgnoreCase));
        var renames = new List<Rename>();
        foreach (var action in declared)
        {
            // Recheck pure collisions with the module too: the pure pass cannot know whether its numbered patch name
            // already belongs to the base. The base pass enriches that same problem, rather than reporting it twice.
            var scoped = ScopedName(action.Scope, action.Name);
            var taken = pure.GetValueOrDefault(scoped) ?? model?.ActionNameTaken(action.Name, action.Scope);
            if (taken == null) continue;
            var occupied = occupiedByScope[action.Scope];
            var free = NameRules.Free(action.Name, occupied);
            while (model?.ActionNameTaken(free, action.Scope) != null) { occupied.Add(free); free = NameRules.Free(action.Name, occupied); }
            occupied.Add(free);
            var existing = model?.Callee(taken.Kind + ":" + taken.Name, action.Caller) ?? PureCallee(taken);
            renames.Add(new(action, taken, free, existing));
        }
        if (renames.Count == 0) return [];
        var edited = ops.DeepClone().AsArray();
        foreach (var rename in renames)
        {
            var data = edited[rename.Action.Op]!["data"]!.AsObject();
            if (rename.Action.JsonIndex >= 0) data["actions"]![rename.Action.JsonIndex]!["name"] = rename.Name;
            else ChangeText(data, rename.Action.TextIndex, text => RenameHeader(text, rename.Name));
        }
        for (var op = 0; op < ops.Count; op++)
        {
            if (edited[op]?["data"] is not JsonObject data || ops[op]?["op"]?.ToString() != "logic") continue;
            foreach (var action in (data["actions"] as JsonArray ?? []).OfType<JsonObject>())
                foreach (var call in LogicScan.Of(action).Calls)
                    if (UniqueRename(call.Target, call.Step["args"] is JsonObject args ? args.Select(p => p.Key).ToArray() : [], renames,
                        Scope(action["kind"]?.ToString()), model, pure) is { } rename)
                        call.Step["call"] = RenameTarget(call.Target, rename.Name);
            if (data["flow"] != null)
            {
                var texts = FlowTextForm.Texts(data);
                for (var t = 0; t < texts.Count; t++) ChangeText(data, t, text => RenameCalls(text, renames, model, pure));
            }
        }
        JsonArray? patch = null;
        if (prefix != null)
        {
            patch = [];
            for (var op = 0; op < ops.Count; op++)
                if (!JsonNode.DeepEquals(ops[op]?["data"], edited[op]?["data"]))
                    Changes(ops[op]!["data"]!, edited[op]!["data"]!, $"{prefix}/{op}/data", patch);
        }
        return renames.Select(rename => {
            var p = JobPreflight.Problem(rename.Action.Op, prefix == null ? null : $"{prefix}/{rename.Action.Op}/data{rename.Action.Pointer}",
                "NAME_COLLISION", "error", $"new action '{rename.Action.Name}' collides with {rename.Taken.Kind} '{rename.Taken.Name}' of {rename.Taken.Owner}; the Studio would rename it to '{rename.Name}'",
                Fix, patch?.DeepClone().AsArray(), "logic", patchRule: "ACTION_RENAMED_FREE_NAME");
            p["taken"] = new JsonObject { ["kind"] = rename.Taken.Kind, ["name"] = rename.Taken.Name, ["owner"] = rename.Taken.Owner };
            return p;
        }).ToList();
    }

    /// <summary>The module-aware patch replaces the pure patch of the same declaration, including the joint renames
    /// of other declarations. Keep one problem and keep the preflight's textual summary consistent with its fields.</summary>
    internal static bool EnrichPreflight(JsonObject? preflight, JsonObject withBase, string? sentPointer)
    {
        if (withBase["code"]?.ToString() != "NAME_COLLISION" || withBase["taken"] == null || preflight?["problems"] is not JsonArray problems) return false;
        var original = problems.OfType<JsonObject>().FirstOrDefault(p => p["code"]?.ToString() == "NAME_COLLISION" && p["pointer"]?.ToString() == sentPointer);
        if (original == null) return false;
        var before = JobPreflight.Text(original);
        foreach (var field in new[] { "patch", "fix", "message", "taken", "patchRule", "patchRules" }) original[field] = withBase[field]?.DeepClone();
        PatchCertainty.Publish(original);
        var after = JobPreflight.Text(original);
        if (preflight["errors"] is JsonArray errors)
            for (var i = 0; i < errors.Count; i++) if (errors[i]?.ToString() == before) errors[i] = after;
        return true;
    }

    private static void Changes(JsonNode before, JsonNode after, string path, JsonArray patch)
    {
        if (JsonNode.DeepEquals(before, after)) return;
        if (before is JsonObject original && after is JsonObject changed)
        {
            foreach (var (key, value) in changed)
                if (original[key] != null && value != null) Changes(original[key]!, value, path + "/" + key.Replace("~", "~0").Replace("/", "~1"), patch);
        }
        else if (before is JsonArray array && after is JsonArray updated)
        {
            for (var i = 0; i < array.Count; i++) if (array[i] != null && updated[i] != null) Changes(array[i]!, updated[i]!, path + "/" + i, patch);
        }
        else patch.Add(new JsonObject { ["op"] = "replace", ["path"] = path, ["value"] = after.DeepClone() });
    }

    private static IEnumerable<Declaration> Declarations(JsonArray ops)
    {
        for (var op = 0; op < ops.Count; op++)
        {
            if (ops[op]?["op"]?.ToString() != "logic" || ops[op]?["data"] is not JsonObject data) continue;
            if (data["actions"] is JsonArray actions)
                for (var i = 0; i < actions.Count; i++)
                {
                    if (actions[i] is not JsonObject a || a["name"]?.ToString() is not { Length: > 0 } name
                        || a["replace"] is JsonValue replace && replace.TryGetValue<bool>(out var replacing) && replacing
                        || JobFacts.Owner(a) != "@espace") continue;
                    yield return new(op, $"/actions/{i}/name", name, a, Inputs(a), Scope(a["kind"]?.ToString()), JsonIndex: i);
                }
            if (data["flow"] == null) continue;
            var texts = FlowTextForm.Texts(data);
            for (var i = 0; i < texts.Count; i++)
            {
                var header = FlowTextForm.Header(texts[i].Text);
                if (header == null || header.Key.Length > 0 || header.Owner.Length > 0 || FlowOwners.Owned(header.Kind)) continue;
                var inputs = new List<ParamFact>();
                try { inputs.AddRange(ModuleFlow.Read(texts[i].Text).Items.Where(x => x.Role == "in")
                    .Select(x => new ParamFact(x.Name, x.Prop("DataType"), x.Prop("IsMandatory") != "False"))); }
                catch (FormatException) {
                    inputs.AddRange(Regex.Matches(texts[i].Text, @"(?m)^  in ([A-Za-z_]\w*)\s*:")
                        .Select(m => new ParamFact(m.Groups[1].Value, null, true)));
                }
                yield return new(op, texts[i].Pointer, header.Name, new JsonObject { ["name"] = header.Name, ["kind"] = Scope(header.Kind) }, inputs, Scope(header.Kind), TextIndex: i);
            }
        }
    }

    private static IReadOnlyList<ParamFact> Inputs(JsonObject action) => (action["inputs"] as JsonArray ?? []).OfType<JsonObject>()
        .Where(p => p["name"] != null).Select(p => new ParamFact(p["name"]!.ToString(), p["type"]?.ToString(), p["mandatory"]?.ToString() != "false")).ToArray();

    private static readonly string[] EntityVerbs = ["Create", "Update", "CreateOrUpdate", "Delete", "Get", "GetForUpdate"];
    private static Dictionary<string, ActionNameFact> ImportedNames(JsonArray ops)
    {
        var names = new Dictionary<string, ActionNameFact>(StringComparer.OrdinalIgnoreCase);
        void Add(ActionNameFact fact) => names.TryAdd(ScopedName(fact.Scope, fact.Name), fact);
        void Entity(string name, string owner, string scope = "server") { foreach (var verb in EntityVerbs) Add(new("IEntityActionSignature", verb + name, owner, scope)); }
        foreach (var op in ops.OfType<JsonObject>())
        {
            if (op["op"]?.ToString() == "spec" && op["data"] is JsonObject data)
            {
                var spec = SpecExpander.Sections(data);
                foreach (var section in new[] { "entities", "clientEntities" })
                    foreach (var e in (spec[section] as JsonArray ?? []).OfType<JsonObject>())
                        if (e["name"]?.ToString() is { Length: > 0 } name) Entity(name, name, section == "clientEntities" ? "client" : "server");
                foreach (var e in (spec["static"] as JsonArray ?? []).OfType<JsonObject>())
                    if (e["name"]?.ToString() is { Length: > 0 } name) Add(new("IEntityActionSignature", "Get" + name, name));
                // Even a malformed later statement cannot hide the entities already declared by this DDL.
                if (data["ddl"] is JsonValue ddl && ddl.TryGetValue<string>(out var text))
                {
                    DdlDocument? document;
                    try { document = DdlParser.Parse(text, MessageExpectations.Lane); }
                    catch (DdlParseException error) { document = error.Partial; }
                    foreach (var e in document?.Elements ?? [])
                        if (!e.Drop && e.Key.Length == 0 && e.Kind is "ServerEntity" or "ClientEntity") Entity(e.Name, e.Name, e.Kind == "ClientEntity" ? "client" : "server");
                }
            }
            if (op["op"]?.ToString() != "reference" || op["elements"] is not JsonArray elements) continue;
            foreach (var element in elements)
            {
                var parts = element?.ToString().Split(':', 2);
                if (parts is not { Length: 2 }) continue;
                var kind = KindNames.Normalize(parts[0]); var owner = op["producer"]?.ToString() ?? "reference";
                if (kind.Contains("Action", StringComparison.Ordinal)) Add(new(kind, parts[1], owner, Scope(kind)));
                else if (kind is "IServerEntity" or "IEntitySignature" or "IClientEntity") Entity(parts[1], owner + "/" + parts[1], kind == "IClientEntity" ? "client" : "server");
            }
        }
        return names;
    }

    private static CalleeFact? PureCallee(ActionNameFact taken)
    {
        if (taken.Kind != "IEntityActionSignature") return null;
        return new(taken.Name, [new ParamFact(taken.Name.StartsWith("Get", StringComparison.Ordinal) || taken.Name.StartsWith("Delete", StringComparison.Ordinal) ? "Id" : "Source", null, true)], []);
    }
    private static bool Fits(IReadOnlyCollection<string> arguments, IReadOnlyList<ParamFact> inputs)
        => arguments.All(a => inputs.Any(i => i.Name.Equals(a, StringComparison.OrdinalIgnoreCase)))
            && inputs.Where(i => i.Mandatory).All(i => arguments.Contains(i.Name, StringComparer.OrdinalIgnoreCase));
    private static Rename? UniqueRename(string target, IReadOnlyCollection<string> arguments, List<Rename> renames,
        string callerScope, IBaseFacts? model, Dictionary<string, ActionNameFact> pure)
    {
        // An explicit existing-kind qualifier names the existing element, never the newly declared action.
        var colon = target.IndexOf(':');
        var name = colon < 0 ? target : target[(colon + 1)..];
        if (name.Contains('.') || name.Contains('/')) return null;
        var scope = colon >= 0 ? Scope(target[..colon]) : callerScope == "client"
            && (renames.Any(r => r.Action.Scope == "client" && r.Action.Name.Equals(name, StringComparison.OrdinalIgnoreCase))
                || pure.ContainsKey(ScopedName("client", name)) || model?.ActionNameTaken(name, "client") != null) ? "client" : "server";
        var matches = renames.Where(r => r.Action.Name.Equals(name, StringComparison.OrdinalIgnoreCase)
            && r.Action.Scope == scope
            && (colon < 0 || target[..colon] is "IServerAction" or "IServiceAction" or "IClientAction" or "IServerActionSignature" or "IServiceActionSignature" or "IClientActionSignature")
            && r.Existing != null && Fits(arguments, r.Action.Inputs) && !Fits(arguments, r.Existing.Inputs)).ToArray();
        return matches.Length == 1 ? matches[0] : null;
    }
    private static string RenameTarget(string target, string name) => target.Contains(':') ? target[..(target.IndexOf(':') + 1)] + name : name;
    private static void ChangeText(JsonObject data, int index, Func<string, string> change)
    {
        if (data["flow"] is JsonValue) data["flow"] = change(data["flow"]!.GetValue<string>());
        else if (data["flow"]![index] is JsonObject item) item["text"] = change(item["text"]!.GetValue<string>());
        else data["flow"]![index] = change(data["flow"]![index]!.GetValue<string>());
    }
    private static string RenameHeader(string text, string name)
        => Regex.Replace(text, @"(?m)^(?<head>(?:server action|client action|service action) )(?<name>[A-Za-z_]\w*)", m => m.Groups["head"].Value + name, RegexOptions.None, TimeSpan.FromSeconds(1));
    private static readonly Regex CallToken = new(@"^(?<before>\s*(?:[A-Za-z_]\w*\s*=\s*)?)(?<target>(?:I\w+:)?[A-Za-z_]\w*)\s*\(", RegexOptions.Compiled);
    private static string RenameCalls(string text, List<Rename> renames, IBaseFacts? model, Dictionary<string, ActionNameFact> pure)
    {
        var callerScope = Scope(FlowTextForm.Header(text)?.Kind);
        var lines = text.Split('\n');
        for (var i = 0; i < lines.Length; i++)
        {
            var match = CallToken.Match(lines[i]);
            if (!match.Success) continue;
            try {
                var call = ModuleFlow.Read("server action CollisionProbe\n  " + lines[i].Trim() + "\n  end\n").Items.FirstOrDefault(n => n.Prop("Action") != null);
                if (call == null) continue;
                if (UniqueRename(match.Groups["target"].Value, call.Items.Where(a => a.Role == "argument").Select(a => a.Name).ToArray(), renames, callerScope, model, pure) is not { } rename) continue;
                var token = match.Groups["target"];
                lines[i] = lines[i][..token.Index] + RenameTarget(token.Value, rename.Name) + lines[i][(token.Index + token.Length)..];
            }
            catch (FormatException) { /* an invalid line has its own diagnostic; never guess a call */ }
        }
        return string.Join("\n", lines);
    }
}
