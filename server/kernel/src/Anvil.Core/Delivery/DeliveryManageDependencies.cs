using System.Text.Json.Nodes;

namespace Anvil.Core.Delivery;

/// <summary>
/// fix-ext-refs (2026-10-16, PMAI_Report_CS + the extension PMAI_Report_Ext, owner: this must never happen):
/// a consumer delivery that needs NEW elements of a producer adds them in one delivery, whatever the producer kind (eSpace
/// module, Extension .xif, system). Before the snapshot, the delivery runs the Studio's own Manage Dependencies on the live
/// module for every producer it captured or binds (bridge refresh_references with add + published, capability
/// refresh_references:add): the elements the job's reference ops name are added from the producer's published signature
/// (the Studio's own catalog; an Extension's signature comes from its published extension reference, never from an OML) and
/// each reference is brought to that signature, in one Studio command. The candidate then changes no producer signature and
/// the merge is the plain native one. The Studio's Refresh References alone never adds an element (a reference that only
/// lacks new elements is "up to date" for it), so before this the candidate carried the published signature and the live
/// merge had to select it, the path that rolled back with "No command is open".
/// A Manage Dependencies the Studio refuses (an element the published signature lacks, an element not allowed in this module
/// kind) is ONE refusal before any merge, every problem with its fix (REFERENCES_NOT_ADDED); nothing was applied. A bridge
/// without the capability delivers as before; if its merge rolls back, the answer names the capability and the exact
/// continuation (the current bridge loads with the next Service Studio opened), never an OML for an Extension and never a
/// person's click.
/// </summary>
public static partial class Delivery
{
    /// <summary>The bridge capability of refresh_references with add/published (Anvil.Bridge RefreshReferencesHandler.Manage).</summary>
    public const string ManageDependenciesCapability = "refresh_references:add";
    /// <summary>The Studio's Manage Dependencies refused the elements this delivery needs: nothing was merged.</summary>
    public const string ReferencesNotAddedCode = "REFERENCES_NOT_ADDED";

    /// <summary>One producer a delivery may align: its binding (the job's reference ops name it), key, name and kind.</summary>
    internal sealed record AlignedProducer(string Binding, string? Key, string? Name, string? Kind);

    /// <summary>The add entries of refresh_references for these producers: each with the elements the job's reference ops
    /// name for its binding (an empty list only aligns the reference to the published signature).</summary>
    internal static JsonArray AlignmentAdd(IReadOnlyList<(string Producer, IReadOnlyList<string> Elements)> referenceOps, IEnumerable<AlignedProducer> producers)
    {
        var add = new JsonArray();
        foreach (var producer in producers)
        {
            var elements = referenceOps.Where(op => string.Equals(op.Producer, producer.Binding, StringComparison.OrdinalIgnoreCase)
                    || producer.Name != null && string.Equals(op.Producer, producer.Name, StringComparison.OrdinalIgnoreCase))
                .SelectMany(op => op.Elements).Distinct(StringComparer.Ordinal).ToList();
            var entry = new JsonObject { ["producer"] = producer.Name ?? producer.Binding };
            if (!string.IsNullOrWhiteSpace(producer.Key)) entry["producer_key"] = producer.Key;
            entry["elements"] = new JsonArray(elements.Select(e => (JsonNode)e).ToArray());
            add.Add(entry);
        }
        return add;
    }

    /// <summary>The refusal of a Manage Dependencies the Studio answered with problems (nothing committed): sets the code and
    /// the problems and returns the error text; null when it committed or did not refuse.</summary>
    internal static string? ReferencesNotAdded(JsonObject result, JsonObject answer)
    {
        if (answer["committed"]?.GetValue<bool>() != false || answer["problems"] is not JsonArray { Count: > 0 } problems) return null;
        result["code"] = ReferencesNotAddedCode;
        result["problems"] = problems.DeepClone();
        return "The Studio's Manage Dependencies did not add the producer elements this delivery needs; nothing was merged and the Manage Dependencies changed nothing (its command rolled back): "
            + string.Join(" ", problems.OfType<JsonObject>().Select(p => p["message"] + " Fix: " + p["fix"]));
    }

    /// <summary>The Studio command a declaration names.</summary>
    public const string ManageDependenciesCommand = "Manage Dependencies";

    /// <summary>
    /// Review A1 (fix-ext-refs round 2): what the Studio's Manage Dependencies did to the delivered module, declared in the task
    /// result and in every answer from its stage on (delivered, refused, rolled back, failed): {command, module, when
    /// (before-merge, after-rollback), committed, changed, added[], alreadyReferenced[], references[{producer, key, kind,
    /// hashBefore, hashAfter, published, atPublished}], undo, text}; a command the Studio rolled back is committed false with its
    /// problems or its error. An earlier run of the same task whose Manage Dependencies changed the module keeps that write
    /// declared (earlier): it stays in the module until Ctrl+Z.
    /// </summary>
    internal static JsonObject DeclareReferencesAdded(JsonObject answer, JsonNode? earlier, string module, string when)
    {
        var committed = answer["committed"]?.GetValue<bool>() == true;
        var declared = new JsonObject { ["command"] = ManageDependenciesCommand, ["module"] = answer["module"]?.ToString() is { Length: > 0 } name ? name : module,
            ["when"] = when, ["committed"] = committed };
        if (committed)
        {
            var added = answer["added"] as JsonArray ?? new JsonArray();
            var references = new JsonArray((answer["references"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().Select(r => (JsonNode)new JsonObject {
                ["producer"] = r["producer"]?.DeepClone(), ["key"] = r["key"]?.DeepClone(), ["kind"] = r["kind"]?.DeepClone(),
                ["hashBefore"] = r["hashBefore"]?.DeepClone(), ["hashAfter"] = r["hashAfter"]?.DeepClone(),
                ["published"] = r["published"]?.DeepClone(), ["atPublished"] = r["atPublished"]?.DeepClone() }).ToArray());
            declared["changed"] = answer["changed"]?.GetValue<bool>() ?? (added.Count > 0 || references.OfType<JsonObject>().Any(Moved));
            declared["added"] = added.DeepClone();
            declared["alreadyReferenced"] = (answer["alreadyReferenced"] as JsonArray ?? new JsonArray()).DeepClone();
            declared["references"] = references;
            declared["undo"] = "Ctrl+Z in Service Studio undoes it (its own Studio command, \"" + ManageDependenciesCommand + "\"); nothing was published";
        }
        else
        {
            declared["changed"] = false;
            foreach (var field in new[] { "code", "stage", "error", "problems", "reason" })
                if (answer[field] is { } value) declared[field] = value.DeepClone();
        }
        if (earlier is JsonObject before && Wrote(before)) declared["earlier"] = before.DeepClone();
        return declared;
    }

    /// <summary>The Studio command of the plain refresh a declaration names.</summary>
    public const string RefreshReferencesCommand = "Refresh References";

    /// <summary>Review A1, the same family (C26): the Studio's Refresh References the delivery ran before the merge on a bridge
    /// without the Manage Dependencies (or as its fallback) is a Studio write too when it changed the module: declared as
    /// {command, module, when, changed, refreshed[], upToDate[], undo, text}, an earlier run's write kept (earlier).</summary>
    internal static JsonObject DeclareReferencesRefreshed(JsonObject answer, JsonNode? earlier, string module)
    {
        var declared = new JsonObject { ["command"] = RefreshReferencesCommand, ["module"] = answer["module"]?.ToString() is { Length: > 0 } name ? name : module,
            ["when"] = "before-merge", ["changed"] = answer["changed"]?.GetValue<bool>() == true,
            ["refreshed"] = (answer["refreshed"] as JsonArray ?? new JsonArray()).DeepClone(), ["upToDate"] = (answer["upToDate"] as JsonArray ?? new JsonArray()).DeepClone(),
            ["undo"] = "Ctrl+Z in Service Studio undoes it (its own Studio command, \"" + RefreshReferencesCommand + "\"); nothing was published" };
        if (earlier is JsonObject before && Wrote(before)) declared["earlier"] = before.DeepClone();
        return declared;
    }

    /// <summary>Whether a detail declaration (or an earlier one of the same task) changed the module.</summary>
    internal static bool Wrote(JsonNode? declared)
        => declared is JsonObject d && (d["changed"]?.GetValue<bool>() == true || Wrote(d["earlier"]));

    private static bool Moved(JsonObject reference)
        => reference["hashAfter"] != null && !string.Equals(reference["hashBefore"]?.ToString(), reference["hashAfter"]?.ToString(), StringComparison.OrdinalIgnoreCase);
    private static string Short(string? hash) => hash is { Length: > 8 } ? hash[..8] : hash ?? "none";
    private static string Names(IReadOnlyList<string> names)
        => names.Count <= 10 ? (names.Count > 1 ? string.Join(", ", names.Take(names.Count - 1)) + " and " + names[^1] : names.FirstOrDefault() ?? "")
            : string.Join(", ", names.Take(10)) + " and " + (names.Count - 10) + " more";

    /// <summary>For the answer of a merge that had to select producer signatures: what the Studio's Manage Dependencies must do
    /// (each producer with its key, kind and the elements the job names), the capability it needs, and whether the loaded
    /// bridge offers it. The facade turns it into the continuation.</summary>
    internal static JsonObject Alignment(JsonArray changes, IReadOnlyList<(string Producer, IReadOnlyList<string> Elements)> referenceOps,
        JsonObject? captured, JsonNode? plan, bool bridgeOffers)
    {
        var producers = new List<AlignedProducer>();
        var kinds = (plan?["Changes"] as JsonArray ?? plan?["changes"] as JsonArray ?? new JsonArray()).OfType<JsonObject>()
            .Where(c => (c["ProducerKey"] ?? c["producerKey"])?.ToString() is { Length: > 0 })
            .GroupBy(c => (c["ProducerKey"] ?? c["producerKey"])!.ToString(), StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => (g.First()["Kind"] ?? g.First()["kind"])?.ToString(), StringComparer.Ordinal);
        foreach (var change in changes.OfType<JsonObject>())
        {
            var key = change["key"]?.ToString();
            var entry = captured?.FirstOrDefault(p => p.Value?["key"]?.ToString() is { Length: > 0 } k && key != null && SameProducerKey(k, key));
            var binding = entry?.Key ?? change["producer"]?.ToString() ?? key ?? "?";
            var kind = entry?.Value?["kind"]?.ToString() ?? (key != null && kinds.TryGetValue(key, out var k2) ? k2 : null);
            producers.Add(new AlignedProducer(binding, key, change["producer"]?.ToString(), kind));
        }
        var add = AlignmentAdd(referenceOps, producers);
        for (var i = 0; i < add.Count; i++) if (producers[i].Kind != null) add[i]!["kind"] = producers[i].Kind;
        return new JsonObject { ["requires"] = ManageDependenciesCapability, ["bridgeOffers"] = bridgeOffers, ["add"] = add };
    }

    /// <summary>The sentence of a rollback answer that names the Studio's Manage Dependencies as the way forward.</summary>
    internal static string AlignmentText(JsonObject alignment, string producerNames, string? reason)
    {
        var add = (alignment["add"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().ToList();
        var extensions = add.Where(a => string.Equals(a["kind"]?.ToString(), "Extension", StringComparison.OrdinalIgnoreCase)).Select(a => a["producer"]?.ToString()).ToList();
        var signatureSource = " (the signature of " + (extensions.Count > 0 ? "an Extension such as " + string.Join(", ", extensions) + " comes from its published extension reference in the Studio, never from an OML; of any other producer, from its published module" : "each producer comes from its published module in the Studio") + ")";
        var studio = "The Studio's own Manage Dependencies adds the elements the job uses and brings " + producerNames + " to the published signature" + signatureSource + ".";
        if (alignment["bridgeOffers"]?.GetValue<bool>() == true)
            return " The same job would roll back the same way" + (reason != null ? " (" + reason + ")" : "") + ". " + studio
                + " It ran and did not align them: run it again with o11_studio refresh-references {module, producers, add, published:true} to see what the Studio refuses and follow each fix; then deliver this job as a new delivery.";
        // servidor/fase4-26 (a7, E1): the hosted kernel (the thin flavor) talks to the bridge of the SSAM agent package; reopening
        // the Service Studio loads the same bridge, so the answer never sends the person to the local shortcut; it names the agent
        // package instead. a8 (the next agent pack): the thin bridge of the current package runs it (capability
        // refresh_references:add); a bridge without it is an older package's, and the answer says the exact step. The flavor is
        // read as ThinBridge.Enabled reads it (this file is also compiled into the ODC kernel, which has no ThinBridge).
        if (Environment.GetEnvironmentVariable("ANVIL_BRIDGE_FLAVOR") == "thin")
            return " The same job would roll back the same way" + (reason != null ? " (" + reason + ")" : "") + ". " + studio
                + " The O11 bridge this Service Studio loaded from the SSAM agent package does not run it (capability " + ManageDependenciesCapability
                + "; hosted, MANAGE_DEPENDENCIES_HOSTED_PENDING): it is an older agent package's bridge. Ask the user to install the current agent package"
                + " and restart Service Studio so the agent loads its bridge (reopening the Studio alone loads the same bridge); then deliver this job as a new delivery:"
                + " with that bridge the delivery adds the elements through the Studio itself before its merge. Nothing was applied.";
        return " The same job would roll back the same way" + (reason != null ? " (" + reason + ")" : "") + ". " + studio
            + " The Service Studio runs a bridge without it (capability " + ManageDependenciesCapability + "): the current bridge loads with the next Service Studio opened"
            + " (the \"Service Studio (SSAM)\" shortcut); then deliver this job as a new delivery: with that bridge the delivery adds the elements through the Studio itself before its merge. Nothing was applied.";
    }
}
