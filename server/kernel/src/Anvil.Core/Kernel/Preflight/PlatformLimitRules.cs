using System.Text.Json.Nodes;

namespace Anvil.Core.Preflight;

/// <summary>
/// R3-B: the rows of <see cref="PlatformLimits"/> the preflight reads over the JSON ops and the logic texts (the data text's
/// are SpecExpander.DdlCreation's, PlatformLimits.DdlNames), with the apply reading the same rows:
/// <list type="bullet">
/// <item>name.maxLength, JSON forms: a raw create or a spec section of an entity attribute or an index whose name is longer
/// than the platform keeps is created with the cut name (ModelSession.Create, nameTruncations; every other op names it by its
/// alias): said here as a warning with its normalization (PLATFORM_NAME_KEPT), the name the create will write, never in
/// silence. A rename to such a name is the author's own name: refused (PLATFORM_NAME_LIMIT, the apply's words).</item>
/// <item>asset.format: a raw create of an image with its binary: format, width and height read from the bytes and written
/// into the args (IMAGE_FACTS_FROM_BYTES, <see cref="NormalizeImages"/>); bytes of no format the lane stores
/// (IMAGE_FORMAT_UNKNOWN) or facts written that the bytes contradict (IMAGE_FACTS_MISMATCH) refused before the build.</item>
/// <item>element.requiresOp (the scope phase, <see cref="OwnOps"/>): a user exception a logic op raises or handles that
/// neither the module nor the job has: no text declares one, so the refusal names the op that does.</item>
/// </list>
/// </summary>
public static class PlatformLimitRules
{
    /// <summary>The pure pass (PreflightChecks.Pure): names of the JSON forms, images of the raw creates.</summary>
    public static List<JsonObject> Check(JsonArray ops, string? prefix, string lane, IReadOnlyList<Expansion> expansions)
    {
        var problems = new List<JsonObject>();
        var aliases = new Dictionary<string, string>(StringComparer.Ordinal);
        var siblings = new Dictionary<(string Parent, string Kind), List<string>>();
        var entityAliases = new Dictionary<string, string>(StringComparer.Ordinal);
        var createdEntities = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op) continue;
            var at = prefix == null ? null : $"{prefix}/{i}";
            switch (op["op"]?.ToString())
            {
                case "create":
                    Created(op, i, at == null ? null : at + "/name", raw: true);
                    if (ImageOf(op) is { } image && AssetFacts.Formats(lane) is { } formats
                        && JudgeImage(op["args"]!.AsObject(), image, formats, KindNames.Normalize(op["type"]?.ToString() ?? "")) is { } judged)
                        problems.Add(JobPreflight.Problem(i, at == null ? null : at + "/args/binary", judged.Code, judged.Refused ? "error" : "warning", judged.Message, judged.Fix, null, "create"));
                    break;
                case "rename" when op["name"] is JsonValue n && n.TryGetValue<string>(out var name)
                    && KindOf(op["target"]?.ToString() ?? "", aliases) is { } type && PlatformLimits.MaxName(type, lane) is { } max && name.Length > max:
                    problems.Add(JobPreflight.Problem(i, at == null ? null : at + "/name", PlatformLimits.NameLimit, "error", PlatformLimits.RenameMessage(type, name, max),
                        $"write a name of at most {max} characters (the platform would keep {name[..max]})", null, "rename"));
                    break;
            }
            foreach (var expansion in expansions.Where(e => e.Op == i))
                foreach (var expanded in expansion.Ops)
                    if (expanded["op"]?.ToString() == "create") Created(expanded, i, at == null ? null : at + "/data", raw: false);
        }
        return problems;

        void Created(JsonObject create, int op, string? pointer, bool raw)
        {
            var type = create["type"]?.ToString() ?? "";
            var kind = PlatformLimits.Kind(type);
            var createdName = create["name"] is JsonValue cn && cn.TryGetValue<string>(out var c) ? c : null;
            if (create["as"] is JsonValue a && a.TryGetValue<string>(out var alias) && type.Length > 0)
            {
                aliases[alias] = type;
                if (createdName != null && IsEntity(kind)) entityAliases[alias] = createdName;
            }
            if (createdName != null && IsEntity(kind)) createdEntities.Add(createdName);
            if (createdName is not { } name || PlatformLimits.MaxName(type, lane) is not { } max) return;
            // Review A5: the siblings are keyed by the entity itself, however the parent is spelled (the spec's alias $E,
            // IServerEntity:E, E), so the name said here is the one the create computes from the entity's real children.
            var owner = Owner(create["parent"]?.ToString() ?? "");
            var key = (owner.ToLowerInvariant(), kind);
            if (!siblings.TryGetValue(key, out var names)) siblings[key] = names = [];
            var kept = PlatformLimits.Kept(type, name, names, lane);
            names.Add(kept);
            if (kept == name) return;
            // A parent of the module (not created by this job): its own children are not known here, so the name is the cut or,
            // when the module already has that name there, the next free numbered one; the apply lists the one it writes.
            var known = createdEntities.Contains(owner);
            var words = PlatformLimits.Words(type);
            var writes = known ? $"the create writes '{kept}'" : $"the create writes '{kept}', or the next free numbered name if {owner} already has an {words} of that name";
            var message = $"{words} '{name}' has {name.Length} characters: the platform keeps at most {max} for an {words} name, so {writes}"
                + (raw ? "" : " (created by this op)") + "; the ops of the job that name it by its alias are unchanged, and the data proof expects the name kept (nameTruncations)";
            var warning = JobPreflight.Problem(op, pointer, PlatformLimits.NameKept, "warning", message,
                $"nothing to change; to keep a name of your own, write one of at most {max} characters", null, raw ? "create" : "spec");
            var entry = JobNormalizer.Entry(PlatformLimits.NameKept, pointer, name, kept, message);
            if (!known) entry["certain"] = false;
            warning["_normalization"] = entry;
            problems.Add(warning);
        }

        string Owner(string parent)
        {
            if (entityAliases.TryGetValue(parent, out var named)) return named;
            if (ModelSession.AliasCounterpart(parent) is { } other && entityAliases.TryGetValue(other, out named)) return named;
            // A spec's entity is named by its alias $Name.
            if (parent.StartsWith('$') && createdEntities.Contains(parent[1..])) return parent[1..];
            var colon = parent.IndexOf(':');
            return colon > 0 && !parent.Contains('/') && !parent.StartsWith('@') ? parent[(colon + 1)..] : parent;
        }
    }

    private static bool IsEntity(string kind) => kind is "Entity" or "ServerEntity" or "StaticEntity" or "ClientEntity" or "LocalEntity";
    /// <summary>Review B1, the base phase (JobRunner, once the base is loaded): the cut names of a data text the job alone could
    /// not prove unique (an entity of the module: a candidate patch, no rule) judged again with the module's names of that
    /// kind (<paramref name="module"/>, its data text) and the job's other ops: the one corrected text becomes certain
    /// (PLATFORM_NAME_KEPT) when nothing there takes the cut, and the patch goes when something does. The problems of the
    /// preflight are rewritten in place, so the one refusal says what the base proves.</summary>
    public static void JudgeCutsWithModule(JsonObject? preflight, JsonArray ops, string lane, Func<Anvil.Reading.DdlDocument?> module)
    {
        var open = (preflight?["problems"] as JsonArray ?? []).OfType<JsonObject>()
            .Where(p => p["code"]?.ToString() == PlatformLimits.NameLimit && p["patchRule"] == null && p["op"] is JsonValue v && v.TryGetValue<int>(out _)).ToList();
        if (open.Count == 0) return;
        Anvil.Reading.DdlDocument? read;
        try { read = module(); } catch { return; }
        if (read == null) return;
        foreach (var group in open.GroupBy(p => p["op"]!.GetValue<int>()))
        {
            if (group.Key < 0 || group.Key >= ops.Count || ops[group.Key] is not JsonObject op || op["data"]?["ddl"] is not JsonValue t || !t.TryGetValue<string>(out var text)) continue;
            List<Anvil.Reading.DdlProblem> again;
            try { again = PlatformLimits.DdlNames(SpecExpander.DdlParse(text), text, lane, read, PlatformLimits.JobSiblings(ops, group.Key, lane)); }
            catch { continue; }
            foreach (var problem in group)
            {
                var line = problem["line"] is JsonValue lv && lv.TryGetValue<int>(out var l) ? l
                    : System.Text.RegularExpressions.Regex.Match(problem["message"]?.ToString() ?? "", @"^line (\d+):") is { Success: true } m ? int.Parse(m.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture) : -1;
                if (again.FirstOrDefault(a => a.Line == line) is not { } judged) continue;
                problem["message"] = $"line {line}: {judged.Message}";
                problem["fix"] = judged.Fix;
                problem["cutDecision"] = judged.Data?["cutDecision"]?.DeepClone();
                if (judged.Corrected != null && judged.Data?["patchRule"] is not null)
                {
                    var path = (problem["patch"] as JsonArray)?.FirstOrDefault()?["path"]?.ToString() ?? $"/ops/{group.Key}/data/ddl";
                    problem["patch"] = new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = path, ["value"] = judged.Corrected });
                    problem["patchRule"] = PlatformLimits.NameKept;
                }
                else problem.Remove("patch");
                PatchCertainty.Publish(problem);
            }
        }
        // Review C1: the sentence of the refusal is written again from the problems as this phase left them.
        JobPreflight.Republish(preflight!);
    }

    /// <summary>The kind a rename's target names: an alias of the job, a Model API interface (IEntityAttribute:X), or a kind the
    /// table names without its I (EntityIndex:X, the index's own target form, which is no interface).</summary>
    private static string? KindOf(string target, IReadOnlyDictionary<string, string> aliases)
    {
        if (PropertyRules.TypeOf(target, aliases) is { } type) return type;
        var colon = target.IndexOf(':');
        if (colon <= 0 || target.StartsWith('@') || target.StartsWith('$') || target.Contains('/')) return null;
        var kind = KindNames.Normalize(target[..colon]);
        return PlatformLimits.MaxName(kind) != null ? kind : null;
    }

    // ---- asset.format ----------------------------------------------------------------------------------------------------

    /// <summary>The bytes of a raw create of an image (type Image, args.binary in base64), or null.</summary>
    private static byte[]? ImageOf(JsonObject op)
    {
        if (op["op"]?.ToString() != "create" || PlatformLimits.Kind(op["type"]?.ToString() ?? "") != "Image"
            || op["args"] is not JsonObject args || args["binary"] is not JsonValue v || !v.TryGetValue<string>(out var base64)) return null;
        try { return Convert.FromBase64String(base64); } catch (FormatException) { return null; }
    }

    /// <summary>The refusal of an image's bytes against the formats a lane stores and the facts the args already write, or null:
    /// IMAGE_FORMAT_UNKNOWN (no format the lane stores, or an SVG without a size), IMAGE_FACTS_MISMATCH (a fact written that the
    /// bytes contradict). The preflight's and the apply's (ModelSession.ImageFactsFromBytes) one judgment.</summary>
    public static (string Code, string Message, string Fix)? ImageProblem(JsonObject args, byte[] bytes, IReadOnlyList<string> formats, string shownType)
    {
        var stored = string.Join(", ", formats);
        var facts = AssetFacts.FromBytes(bytes);
        if (facts == null)
        {
            var sniffed = AssetFacts.Sniff(bytes);
            return (AssetFacts.UnknownFormat,
                sniffed == "svg" ? $"create {shownType}: the binary is an SVG with no size of its own (its <svg> has neither width and height in px nor a viewBox), so its width and height cannot be read"
                    : $"create {shownType}: the binary ({bytes.Length} bytes) is no image of a format the Studio stores ({stored}): its first bytes are none of their signatures",
                sniffed == "svg" ? "write a viewBox (or width and height in px) on the <svg> element" : $"send the file itself, in one of: {stored}");
        }
        if (AssetFacts.EnumValue(facts.Format, formats) is not { } format)
            return (AssetFacts.UnknownFormat, $"create {shownType}: the binary is a {facts.Format.ToUpperInvariant()} image of {facts.Width}x{facts.Height}, a format the Studio does not store (it stores {stored})",
                $"convert it to one of: {stored} (PNG keeps every pixel)");
        var wrong = new List<string>();
        if (args["format"] is JsonValue fv && fv.TryGetValue<string>(out var written) && AssetFacts.EnumValue(written.Trim().ToLowerInvariant() switch { "jpg" => "jpeg", var w => w }, formats) is var writtenFormat
            && !string.Equals(writtenFormat ?? written, format, StringComparison.OrdinalIgnoreCase))
            wrong.Add($"format {written} (the bytes are {format})");
        foreach (var (name, value) in new[] { ("width", facts.Width), ("height", facts.Height) })
            if (args[name] is JsonValue sv && (sv.TryGetValue<int>(out var given) || int.TryParse(sv.ToString(), out given)) && given != value) wrong.Add($"{name} {given} (the bytes say {value})");
        return wrong.Count == 0 ? null : (AssetFacts.Mismatch, $"create {shownType}: the args contradict the bytes, a {facts.Format.ToUpperInvariant()} image of {facts.Width}x{facts.Height}: {string.Join("; ", wrong)}",
            "leave format, width and height out (they are read from the bytes), or write the bytes' own");
    }

    /// <summary>The one judgment of an image create, the preflight's and the create's (ModelSession.ImageFactsFromBytes):
    /// with format, width and height all written (AssetFacts.Declared) the author's facts win and what the bytes say against
    /// them is a note (IMAGE_FACTS_DECLARED, Refused false); otherwise <see cref="ImageProblem"/> refuses (Refused true). Null
    /// when nothing is to be said.</summary>
    public static (bool Refused, string Code, string Message, string Fix)? JudgeImage(JsonObject args, byte[] bytes, IReadOnlyList<string> formats, string shownType)
    {
        var problem = ImageProblem(args, bytes, formats, shownType);
        if (problem is not { } p) return null;
        if (!AssetFacts.Declared(args)) return (true, p.Code, p.Message, p.Fix);
        return (false, AssetFacts.DeclaredNote,
            $"{p.Message}; format, width and height are all written, so they are stored as written (the author's facts win over the bytes)",
            "nothing to change if the written facts are meant; else leave format, width and height out and they are read from the bytes");
    }

    /// <summary>The args the facts give, in the lane's ImageFormat spelling.</summary>
    public static IEnumerable<(string Name, JsonNode Value)> FactValues(ImageFacts facts, IReadOnlyList<string> formats)
    {
        yield return ("format", JsonValue.Create(AssetFacts.EnumValue(facts.Format, formats)!)!);
        yield return ("width", JsonValue.Create(facts.Width));
        yield return ("height", JsonValue.Create(facts.Height));
    }

    /// <summary>IMAGE_FACTS_FROM_BYTES (JobNormalizer, the job alone): format, width and height written into the args of a raw
    /// create of an image whose binary states them, when the lane's formats are known and the args do not contradict them (that
    /// is <see cref="Check"/>'s refusal). Idempotent: an image with its facts written is left alone.</summary>
    public static void NormalizeImages(JsonArray ops, string? prefix, string lane, List<JsonObject> done)
    {
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || ImageOf(op) is not { } bytes || op["args"] is not JsonObject args) continue;
            if (AssetFacts.Declared(args)) continue;
            if (AssetFacts.Formats(lane) is not { } formats || JudgeImage(args, bytes, formats, "IImage") != null || AssetFacts.FromBytes(bytes) is not { } facts) continue;
            var filled = new List<string>();
            foreach (var (name, value) in FactValues(facts, formats))
                if (!args.ContainsKey(name)) { args[name] = value; filled.Add($"{name} {value}"); }
            done.Add(JobNormalizer.Entry(AssetFacts.FactsRule, prefix == null ? null : $"{prefix}/{i}/args", "binary without " + string.Join(", ", filled.Select(f => f.Split(' ')[0])),
                string.Join(", ", filled), $"create {op["name"] ?? "IImage"}: the bytes are a {facts.Format.ToUpperInvariant()} image of {facts.Width}x{facts.Height}: {string.Join(", ", filled)} read from them"));
        }
    }

    // ---- element.requiresOp ------------------------------------------------------------------------------------------------

    /// <summary>ELEMENT_REQUIRES_OP (scope phase): a user exception a logic op raises or handles (`raise X(...)`, `on exception
    /// X:` in a text, `raise` of a JSON step) that is no System exception, no element of the module (or of its references)
    /// and no create of this job: the apply answered FLOW_NAME_UNKNOWN (APPLY_FAILED for the JSON form) one round later. A job
    /// with an op that makes elements this reader cannot list (a generator) or imports references is not judged.</summary>
    internal static IEnumerable<JsonObject> OwnOps(JsonArray ops, string? prefix, ScopeJob job, IBaseFacts facts)
    {
        if (job.Generators || ops.OfType<JsonObject>().Any(o => o["op"]?.ToString() == "reference")) yield break;
        var created = ops.OfType<JsonObject>().Where(o => o["op"]?.ToString() == "create" && PlatformLimits.Kind(KindNames.Normalize(o["type"]?.ToString() ?? "")) == "UserException")
            .Select(o => o["name"]?.ToString()).OfType<string>().ToHashSet(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "logic" || op["data"] is not JsonObject data) continue;
            var named = new List<(string Name, string At, bool Text)>();
            foreach (var (text, at) in FlowTexts(data)) foreach (var name in PlatformLimits.ExceptionsOf(text)) named.Add((name, at, true));
            if (data["actions"] is JsonArray actions) named.AddRange(Raised(actions, "/data/actions"));
            foreach (var (name, at, text) in named.DistinctBy(n => n.Name, StringComparer.OrdinalIgnoreCase))
            {
                if (created.Contains(name) || facts.HasName(name) || ValueAliases.SystemExceptions.Contains(ValueAliases.SystemExceptionKey(name))) continue;
                yield return ScopeRules.Problem(i, prefix == null ? null : $"{prefix}/{i}{at}", PlatformLimits.RequiresOp, text ? "FLOW_NAME_UNKNOWN" : "APPLY_FAILED",
                    $"logic: the exception {name} is raised or handled here, and it is no exception of the module, of its references or of this job: a user exception has no form in the logic text or the data text (it is created by an op of its own)",
                    $"create it before this op: {{\"op\":\"create\",\"parent\":\"@espace\",\"type\":\"IUserException\",\"name\":\"{name}\"}}; or name an exception the module has",
                    null, "logic");
            }
        }
    }

    private static IEnumerable<(string Name, string At, bool Text)> Raised(JsonNode? node, string at)
    {
        switch (node)
        {
            case JsonObject o:
                if (o["raise"] is JsonValue r && r.TryGetValue<string>(out var raised) && raised.Length > 0 && !raised.Contains(':')) yield return (raised, at + "/raise", false);
                foreach (var (key, child) in o) foreach (var found in Raised(child, at + "/" + key)) yield return found;
                break;
            case JsonArray a:
                for (var k = 0; k < a.Count; k++) foreach (var found in Raised(a[k], at + "/" + k)) yield return found;
                break;
        }
    }

    /// <summary>The texts of a logic op's flow form, with their pointers inside the op.</summary>
    private static IEnumerable<(string Text, string At)> FlowTexts(JsonObject data)
    {
        switch (data["flow"])
        {
            case JsonValue v when v.TryGetValue<string>(out var single): yield return (single, "/data/flow"); break;
            case JsonArray list:
                for (var n = 0; n < list.Count; n++)
                {
                    if (list[n] is JsonValue item && item.TryGetValue<string>(out var text)) yield return (text, $"/data/flow/{n}");
                    else if (list[n] is JsonObject o && o["text"] is JsonValue t && t.TryGetValue<string>(out var inner)) yield return (inner, $"/data/flow/{n}/text");
                }
                break;
        }
    }
}
