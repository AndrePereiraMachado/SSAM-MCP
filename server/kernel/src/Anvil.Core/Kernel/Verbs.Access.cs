using System.Text.Json.Nodes;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// T12 (Traditional migration: 21 source screens set to Roles=[Registered] for a comparison, the restore tracked by hand):
/// every write of a job to who may open an existing screen (Roles, AnonymousAccess, by set or by link) is recorded with the
/// screen's exact value before the job's first write to it. The receipt carries accessChanges [{screen, key, property, from,
/// to, fromNames, toNames}] (roles as @keys, which set Roles resolves, and by name) and accessRestore {ops}: the set ops that
/// put every screen back as it was. A screen the job created has nothing to restore. The facade keeps the restore journal of a
/// temporary change (o11-access.mjs) from these fields.
/// </summary>
public sealed partial class ModelSession
{
    private readonly Dictionary<IObjectSignature, Dictionary<string, (JsonNode? Value, JsonNode? Names)>> _accessBefore = new(ReferenceEqualityComparer.Instance);

    /// <summary>Called by the verbs before a write to Roles or AnonymousAccess: keeps the value before the first one.</summary>
    private void RememberAccess(object target, string property)
    {
        if (target is not IObjectSignature screen || !ModelHost.IsScreen(target)) return;
        if (!_accessBefore.TryGetValue(screen, out var kept)) _accessBefore[screen] = kept = new(StringComparer.Ordinal);
        if (!kept.ContainsKey(property)) kept[property] = AccessValue(screen, property);
    }

    private static (JsonNode? Value, JsonNode? Names) AccessValue(IObjectSignature screen, string property)
    {
        if (property == "AnonymousAccess") return (ModelHost.Prop(screen, "AnonymousAccess") is bool open ? JsonValue.Create(open) : null, null);
        object? value;
        try { value = UiCatalog.Prop(screen, "Roles"); } catch { value = null; }
        var roles = (value as System.Collections.IEnumerable)?.Cast<object>().OfType<IObjectSignature>()
            .Select(r => (Key: "@" + r.ObjectKey, Name: TypeResolver.Name(r) ?? "")).OrderBy(r => r.Key, StringComparer.Ordinal).ToArray() ?? [];
        return (new JsonArray(roles.Select(r => (JsonNode)JsonValue.Create(r.Key)!).ToArray()),
            new JsonArray(roles.Select(r => (JsonNode)JsonValue.Create(r.Name)!).ToArray()));
    }

    /// <summary>T12: `ifCurrent` on a set of Roles or AnonymousAccess (the restore ops carry it): the write applies only while
    /// the screen still has that value; a later change makes it a refusal that names the screen and both values, and nothing
    /// is written. Roles compare as sets of @keys.</summary>
    private void CheckAccessCurrent(object target, string property, JsonNode? wanted)
    {
        if (wanted is null) return;
        if (property is not ("Roles" or "AnonymousAccess") || target is not IObjectSignature screen || !ModelHost.IsScreen(target))
            throw new InvalidOperationException($"set {property}: ifCurrent applies only to Roles and AnonymousAccess of a screen");
        var (current, names) = AccessValue(screen, property);
        static string Norm(JsonNode? v) => v is JsonArray a ? string.Join(",", a.Select(x => x?.ToString() ?? "").Order(StringComparer.Ordinal)) : v?.ToJsonString() ?? "null";
        if (Norm(current) == Norm(wanted)) return;
        var name = TypeResolver.Name(screen);
        var shown = property == "Roles" ? $"[{Norm(current)}] ({string.Join(", ", names?.AsArray().Select(n => n?.ToString()) ?? [])})" : Norm(current);
        var message = $"set {property} on screen '{name}': this restore applies only while {property} is [{Norm(wanted)}], and the screen has {shown} now (a later change); nothing was written";
        const string fix = "restore the newer temporary change of this screen first (ssam_doctor lists them, newest first), or keep the screen as it is and close this restore with the user's words";
        throw new KernelRefusalException("ACCESS_RESTORE_CONFLICT", message + ". Fix: " + fix,
            new JsonArray(JobPreflight.PublicProblem(JobPreflight.Problem(null, null, "ACCESS_RESTORE_CONFLICT", "error", message, fix))));
    }

    /// <summary>The access changes of this apply (screens the job did not create, whose value differs from the one before) and
    /// the ops that restore them.</summary>
    private (JsonArray Changes, JsonArray Restore) AccessChanges(JobFootprint? footprint)
    {
        var changes = new JsonArray(); var restore = new JsonArray();
        foreach (var (screen, properties) in _accessBefore.OrderBy(s => ModelHost.PathOf(s.Key), StringComparer.Ordinal))
        {
            if (screen.WasDeleted || screen.ObjectKey?.ToString() is not { } key || footprint?.Created.Contains(key) == true) continue;
            foreach (var (property, before) in properties.OrderBy(p => p.Key, StringComparer.Ordinal))
            {
                var after = AccessValue(screen, property);
                if (JsonNode.DeepEquals(before.Value, after.Value)) continue;
                changes.Add(new JsonObject { ["screen"] = TypeResolver.Name(screen), ["key"] = key, ["path"] = ModelHost.PathOf(screen), ["property"] = property,
                    ["from"] = before.Value?.DeepClone(), ["to"] = after.Value?.DeepClone(),
                    ["fromNames"] = before.Names?.DeepClone(), ["toNames"] = after.Names?.DeepClone() });
                restore.Add(new JsonObject { ["op"] = "set", ["target"] = "@" + key, ["prop"] = property, ["value"] = before.Value?.DeepClone(), ["ifCurrent"] = after.Value?.DeepClone() });
            }
        }
        return (changes, restore);
    }
}
