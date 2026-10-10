using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core.Access;

/// <summary>One grant or revoke of one persistent role of an owner module to one existing end user.</summary>
public sealed record AccessEntry(string Username, string Module, string Role, bool Grant, bool Demo, bool CreateIfMissing)
{
    public string RoleCode => Role;
    public string Qualified => Module + "." + Role;
}

/// <summary>
/// The versioned access manifest of the O11 lane (design: kernel/docs/tasks/2026-09-26-o11-capacidades-headless.md, 2.2, option A).
/// Closed schema; the digest covers the intent only (environment, version, flags and the sorted entries), never the local base
/// paths, so the same manifest read from another folder has the same digest.
///
/// {"environment":"personal-x.outsystemscloud.com","manifestVersion":1,
///  "bases":{"Orders_CS":"bases/Orders_CS-v5578.oml"},
///  "entries":[{"username":"Planner","demo":true,"role":"Orders_CS.Planner","action":"grant"}]}
/// </summary>
public sealed record AccessManifest(string Path, string Environment, int ManifestVersion, bool AllowNonDemoAccounts,
    IReadOnlyList<AccessEntry> Entries, IReadOnlyDictionary<string, string> Bases, string Canonical, string Sha256)
{
    public const string Schema = "ssam-access/1";
    private static readonly string[] RootKeys = ["schema", "environment", "manifestVersion", "allowNonDemoAccounts", "bases", "entries", "description"];
    private static readonly string[] EntryKeys = ["username", "role", "action", "demo", "createIfMissing"];
    // Usernames become OutSystems text literals and static record values: a closed alphabet keeps them inert.
    private static readonly Regex UsernameShape = new(@"^[A-Za-z0-9][A-Za-z0-9._@+\-]{0,249}$", RegexOptions.Compiled);
    private static readonly Regex Identifier = new(@"^[A-Za-z_][A-Za-z0-9_]{0,99}$", RegexOptions.Compiled);
    private static readonly Regex Host = new(@"^[a-z0-9]([a-z0-9\-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9\-]*[a-z0-9])?)+$", RegexOptions.Compiled);

    public IEnumerable<string> Modules => Entries.Select(e => e.Module).Distinct(StringComparer.OrdinalIgnoreCase);

    public static AccessManifest Read(string path)
    {
        var full = System.IO.Path.GetFullPath(path);
        if (!File.Exists(full)) throw new FileNotFoundException("access manifest not found: " + full);
        JsonNode? node;
        try { node = JsonNode.Parse(File.ReadAllText(full)); }
        catch (JsonException ex) { throw new ArgumentException("access manifest is not valid JSON: " + ex.Message); }
        return Parse(node, full);
    }

    /// <summary>Parses and normalizes; every independent schema error is reported together.</summary>
    public static AccessManifest Parse(JsonNode? node, string path)
    {
        if (node is not JsonObject root) throw new ArgumentException("access manifest: the root must be an object");
        var errors = new List<string>();
        foreach (var unknown in root.Select(p => p.Key).Except(RootKeys, StringComparer.Ordinal))
            errors.Add($"unknown key '{unknown}' (allowed: {string.Join(", ", RootKeys)})");
        if (root["schema"] is { } schema && schema.ToString() != Schema) errors.Add($"schema must be \"{Schema}\"");
        var environment = Text(root, "environment")?.Trim().ToLowerInvariant();
        if (string.IsNullOrEmpty(environment)) errors.Add("environment is required (host of the O11 environment, e.g. personal-x.outsystemscloud.com)");
        else if (!Host.IsMatch(environment)) errors.Add($"environment '{environment}' must be a bare host name, without scheme or path");
        var version = 0;
        if (root["manifestVersion"] is JsonValue v && v.TryGetValue<int>(out var parsed)) version = parsed;
        if (version < 1) errors.Add("manifestVersion is required and must be an integer >= 1 (monotonic: every change raises it)");
        var allowNonDemo = Flag(root, "allowNonDemoAccounts", errors) ?? false;

        var bases = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (root["bases"] is JsonObject b)
            foreach (var (module, value) in b)
            {
                if (!Identifier.IsMatch(module)) { errors.Add($"bases: '{module}' is not a module name"); continue; }
                var text = value?.ToString();
                if (string.IsNullOrWhiteSpace(text)) { errors.Add($"bases.{module}: empty path"); continue; }
                bases[module] = System.IO.Path.GetFullPath(text, System.IO.Path.GetDirectoryName(path) ?? Directory.GetCurrentDirectory());
            }
        else if (root["bases"] != null) errors.Add("bases must be an object {\"Module\": \"<path to its current OML>\"}");

        var entries = new List<AccessEntry>();
        if (root["entries"] is not JsonArray list || list.Count == 0) errors.Add("entries must be a non-empty array");
        else
            for (var i = 0; i < list.Count; i++)
            {
                var at = $"entries[{i}]";
                if (list[i] is not JsonObject e) { errors.Add(at + ": must be an object"); continue; }
                foreach (var unknown in e.Select(p => p.Key).Except(EntryKeys, StringComparer.Ordinal))
                    errors.Add($"{at}: unknown key '{unknown}' (allowed: {string.Join(", ", EntryKeys)})");
                var username = Text(e, "username")?.Trim();
                if (string.IsNullOrEmpty(username)) errors.Add(at + ": username is required");
                else if (!UsernameShape.IsMatch(username)) errors.Add($"{at}: username has characters outside [A-Za-z0-9._@+-] or is longer than 250");
                var role = Text(e, "role")?.Trim();
                string module = "", roleName = "";
                if (string.IsNullOrEmpty(role)) errors.Add(at + ": role is required as \"Module.Role\"");
                else
                {
                    var dot = role.LastIndexOf('.');
                    if (dot <= 0 || dot == role.Length - 1) errors.Add($"{at}: role '{role}' must be qualified as \"Module.Role\" (the owner module of the role)");
                    else
                    {
                        module = role[..dot]; roleName = role[(dot + 1)..];
                        if (!Identifier.IsMatch(module) || !Identifier.IsMatch(roleName)) errors.Add($"{at}: role '{role}' is not Module.Role with identifier names");
                    }
                }
                var action = Text(e, "action")?.Trim().ToLowerInvariant();
                if (action is not ("grant" or "revoke")) errors.Add($"{at}: action must be \"grant\" or \"revoke\"");
                var demo = Flag(e, "demo", errors, at);
                if (demo == null) errors.Add($"{at}: demo is required (true for a demo account; the plan checks it against the DemoLoginUsernames / OpsDemoLoginUsernames defaults of the owner module and refuses a mismatch)");
                var create = Flag(e, "createIfMissing", errors, at) ?? false;
                if (create && action == "revoke") errors.Add($"{at}: createIfMissing applies only to grant");
                if (!string.IsNullOrEmpty(username) && module.Length > 0 && action != null && demo != null)
                    entries.Add(new AccessEntry(username, module, roleName, action == "grant", demo.Value, create));
            }
        foreach (var group in entries.GroupBy(e => (User: e.Username.ToLowerInvariant(), Role: e.Qualified.ToLowerInvariant())).Where(g => g.Count() > 1))
            errors.Add(group.Select(e => e.Grant).Distinct().Count() > 1
                ? $"conflicting grant and revoke of {group.First().Qualified} for the same username (hash {UsernameHash(environment ?? "", group.First().Username)})"
                : $"repeated entry {group.First().Qualified} for the same username (hash {UsernameHash(environment ?? "", group.First().Username)})");
        foreach (var group in entries.GroupBy(e => e.Username.ToLowerInvariant()).Where(g => g.Select(e => e.Demo).Distinct().Count() > 1))
            errors.Add($"username (hash {UsernameHash(environment ?? "", group.First().Username)}) is marked demo in one entry and not in another");
        if (errors.Count > 0) throw new AccessManifestException(errors);

        var ordered = entries.OrderBy(e => e.Module, StringComparer.OrdinalIgnoreCase).ThenBy(e => e.Role, StringComparer.OrdinalIgnoreCase)
            .ThenBy(e => e.Username, StringComparer.OrdinalIgnoreCase).ToList();
        var canonical = new JsonObject
        {
            ["schema"] = Schema, ["environment"] = environment, ["manifestVersion"] = version, ["allowNonDemoAccounts"] = allowNonDemo,
            ["entries"] = new JsonArray(ordered.Select(EntryJson).ToArray()),
        }.ToJsonString();
        return new AccessManifest(path, environment!, version, allowNonDemo, ordered, bases, canonical, Hash(canonical));
    }

    internal static JsonNode EntryJson(AccessEntry e) => new JsonObject
    {
        ["module"] = e.Module, ["role"] = e.Role, ["username"] = e.Username, ["action"] = e.Grant ? "grant" : "revoke",
        ["demo"] = e.Demo, ["createIfMissing"] = e.CreateIfMissing,
    };

    /// <summary>Pseudonym of a username for receipts and console output: never the name itself. Scoped by environment;
    /// a dictionary of known demo names can still reverse it, so it is a pseudonym, not a secret.</summary>
    public static string UsernameHash(string environment, string username)
        => Hash(environment.Trim().ToLowerInvariant() + "\n" + username.Trim().ToLowerInvariant())[..16];

    public static string Hash(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();

    private static string? Text(JsonObject o, string key) => o[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : o[key] == null ? null : o[key]!.ToJsonString();

    private static bool? Flag(JsonObject o, string key, List<string> errors, string at = "")
    {
        if (o[key] == null) return null;
        if (o[key] is JsonValue v && v.TryGetValue<bool>(out var b)) return b;
        errors.Add((at.Length > 0 ? at + ": " : "") + key + " must be true or false");
        return null;
    }
}

public sealed class AccessManifestException(IReadOnlyList<string> errors)
    : ArgumentException("access manifest refused: " + string.Join("; ", errors))
{
    public IReadOnlyList<string> Errors { get; } = errors;
}
