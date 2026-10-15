using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>
/// Familias (2026-10-12, VisitaCerta_UI round of 20:33): of 244 pointers, 173 were the cascade of four faults (101
/// HTML_NAME_UNKNOWN of screen actions whose logic text did not parse, 72 FLOW_OWNER_UNKNOWN of screens whose document failed).
/// A problem of the apply or the Verify that names something the job itself declares, in a part of the job (an op, or one
/// text of a logic op) that failed, is that failure seen again: it leaves the problems, and the root it comes from says
/// `blocks: N` (with the first few of them in `blocked`). Transitive: a document that failed only because of such names
/// passes its own cascade to the roots of those names. A part that failed for a fault of its own keeps that fault as a root.
/// </summary>
public static partial class JobRunner
{
    /// <summary>A part of the job that declares names: an op, or one text of a logic op's data.flow.</summary>
    private sealed record Part(int Op, string Pointer);

    private static readonly Regex FlowHeader = new(@"^(?:server action|service action|client action|data action|action) (?:(?<owner>[^\s.]+(?:/[^\s.]+)?)\.)?(?<name>[A-Za-z_][A-Za-z0-9_]*)", RegexOptions.Compiled | RegexOptions.Multiline);
    private static readonly Regex OwnerNamed = new(@"names the owner (?:[^\s/]+/)?(?<name>[A-Za-z_][A-Za-z0-9_]*)", RegexOptions.Compiled);
    // FLOW_NAME_UNKNOWN says the property and the name it could not resolve: "Destination = LocaisSalvos".
    private static readonly Regex PropertyNamed = new(@"^[A-Za-z]+ = (?:[^\s/]+/)?(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*$", RegexOptions.Compiled);

    /// <summary>The names each part of the job declares (by part), from the job alone: the root of a document (its screen or
    /// block), the actions of a logic op (its JSON or the headers of its texts), the elements a create names.</summary>
    private static Dictionary<Part, HashSet<string>> Declarations(JsonArray ops, string opsPointer)
    {
        var parts = new Dictionary<Part, HashSet<string>>();
        void Add(Part part, string name) { if (name.Length > 0) (parts.TryGetValue(part, out var set) ? set : parts[part] = new HashSet<string>(StringComparer.OrdinalIgnoreCase)).Add(name); }
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op) continue;
            var whole = new Part(i, $"{opsPointer}/{i}");
            switch (op["op"]?.ToString())
            {
                case "html" when Preflight.ScreenDocFacts.Of(op, i) is { } doc:
                    Add(whole, doc.Name);
                    break;
                case "logic" when op["data"] is JsonObject data:
                    if (data["actions"] is JsonArray actions)
                        foreach (var action in actions.OfType<JsonObject>()) Add(whole, action["name"]?.ToString() ?? "");
                    if (data.ContainsKey("flow"))
                        Preflight.FlowTexts.Rewrite(data, $"{opsPointer}/{i}", (text, at) =>
                        {
                            foreach (Match m in FlowHeader.Matches(text)) Add(new Part(i, at ?? whole.Pointer), m.Groups["name"].Value);
                            return null;
                        });
                    break;
                case "create":
                    Add(whole, op["name"]?.ToString() ?? "");
                    break;
            }
        }
        return parts;
    }

    private static bool Error(JsonObject p) => p["severity"]?.ToString() is null or "error";

    // The problems that say a name was not found: of the html and logic text compiles, of the base check, and the Verify's.
    private static readonly HashSet<string> NotFound = new(StringComparer.Ordinal) { "HTML_NAME_UNKNOWN", "FLOW_OWNER_UNKNOWN", "FLOW_NAME_UNKNOWN", "REFERENCE_UNRESOLVED", "CHILD_NOT_FOUND" };
    private static bool SaysNotFound(JsonObject p) => p["code"]?.ToString() is { } code && (NotFound.Contains(code) || p["phase"]?.ToString() == "verify" && code.Contains("Unknown", StringComparison.Ordinal));

    /// <summary>The names a problem says it could not find: the quoted names of its message, and the owner a logic text's
    /// header names (FLOW_OWNER_UNKNOWN says it unquoted).</summary>
    private static HashSet<string> Missing(JsonObject p)
    {
        var names = Subjects(p);
        if (OwnerNamed.Match(p["message"]?.ToString() ?? "") is { Success: true } m) names.Add(m.Groups["name"].Value);
        if (p["code"]?.ToString() == "FLOW_NAME_UNKNOWN" && PropertyNamed.Match(p["message"]?.ToString() ?? "") is { Success: true } n) names.Add(n.Groups["name"].Value);
        return names;
    }

    /// <summary>The problems without the cascade of the failed parts, and each root with blocks/blocked. Pure (the problems and
    /// the job); a job without a pointer prefix (a composite) is returned as it is.</summary>
    internal static List<JsonObject> FoldCascade(List<JsonObject> all, JsonArray ops, string? opsPointer)
    {
        if (opsPointer == null || all.Count == 0) return all;
        var declared = Declarations(ops, opsPointer);
        if (declared.Count == 0) return all;
        // The part a problem is in: the text of a logic op when its pointer is inside one, else the op.
        Part? PartOf(JsonObject p)
        {
            if (p["op"] is not JsonValue v || !v.TryGetValue<int>(out var op)) return null;
            var pointer = p["pointer"]?.ToString() ?? "";
            var text = declared.Keys.FirstOrDefault(k => k.Op == op && k.Pointer != $"{opsPointer}/{op}" && (pointer == k.Pointer || pointer.StartsWith(k.Pointer + "/", StringComparison.Ordinal)));
            return text ?? new Part(op, $"{opsPointer}/{op}");
        }
        // A part failed when what it declares is not there: an error of its apply, or a text the preflight could not read (a
        // *_SYNTAX, a JSON shape). Never the Verify's (what it judged was applied) nor a preflight rule (the part still applies).
        // An op-level failure of a logic op fails all its texts.
        static bool Failing(JsonObject p) => p["phase"]?.ToString() == "apply"
            || p["phase"]?.ToString() is "preflight" or "base" && p["code"]?.ToString() is { } code && (code.EndsWith("_SYNTAX", StringComparison.Ordinal) || code is JobDocument.ShapeCode or "OP_NOT_OBJECT");
        var failed = new Dictionary<Part, List<JsonObject>>();
        foreach (var p in all.Where(p => Error(p) && Failing(p)))
        {
            if (PartOf(p) is not { } part) continue;
            (failed.TryGetValue(part, out var list) ? list : failed[part] = []).Add(p);
            if (p["pointer"]?.ToString() == part.Pointer && part.Pointer == $"{opsPointer}/{part.Op}")
                foreach (var text in declared.Keys.Where(k => k.Op == part.Op && k != part))
                    (failed.TryGetValue(text, out var texts) ? texts : failed[text] = []).Add(p);
        }
        // Each problem of the apply or the Verify that names a name a failed part (other than its own) declares: a cascade of it.
        var causes = new Dictionary<JsonObject, List<Part>>(ReferenceEqualityComparer.Instance);
        foreach (var p in all.Where(p => Error(p) && p["phase"]?.ToString() is "apply" or "verify" && SaysNotFound(p)))
        {
            var own = PartOf(p);
            var names = Missing(p);
            if (names.Count == 0) continue;
            var from = declared.Where(d => d.Key != own && failed.ContainsKey(d.Key) && d.Value.Overlaps(names)).Select(d => d.Key).ToList();
            if (from.Count > 0) causes[p] = from;
        }
        if (causes.Count == 0) return all;
        // The roots of a part: its problems that are no cascade, or (all of them cascades) the roots of their causes.
        var roots = new Dictionary<Part, List<JsonObject>>();
        List<JsonObject> RootsOf(Part part, HashSet<Part> seen)
        {
            if (roots.TryGetValue(part, out var known)) return known;
            if (!seen.Add(part) || !failed.TryGetValue(part, out var problems)) return [];
            var own = problems.Where(p => !causes.ContainsKey(p)).ToList();
            var result = own.Count > 0 ? own : problems.SelectMany(p => causes[p].SelectMany(c => RootsOf(c, seen))).Distinct(ReferenceEqualityComparer.Instance).Cast<JsonObject>().ToList();
            roots[part] = result;
            return result;
        }
        var blocked = new Dictionary<JsonObject, List<JsonObject>>(ReferenceEqualityComparer.Instance);
        foreach (var (p, from) in causes)
        {
            var origin = from.SelectMany(c => RootsOf(c, [])).Where(r => !ReferenceEquals(r, p)).Distinct(ReferenceEqualityComparer.Instance).Cast<JsonObject>().ToList();
            // No root found (a cycle of cascades): the problem stays, it is its own root.
            if (origin.Count == 0) { causes.Remove(p); continue; }
            foreach (var root in origin) (blocked.TryGetValue(root, out var list) ? list : blocked[root] = []).Add(p);
        }
        foreach (var (root, list) in blocked)
        {
            root["blocks"] = list.Count;
            root["blocked"] = new JsonArray(list.Take(3).Select(b => (JsonNode)$"{b["code"]} ({b["phase"]}) at {b["pointer"]}: {Clip(b["message"]?.ToString())}").ToArray());
        }
        return all.Where(p => !causes.ContainsKey(p)).ToList();
    }

    private static string Clip(string? text) => text == null ? "" : text.Length > 120 ? text[..120] + "..." : text;
}
