using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;
using OutSystems.Model;

namespace Anvil.Core.Access;

/// <summary>What the planner needs to know about one owner module, read offline from its current OML.</summary>
public sealed record AccessRoleFact(string Name, bool IsPersistent, string? CheckAction, string? GrantAction, string? RevokeAction);

/// <summary>Marker the generator writes in the Description of the AccessManifest static entity; it is how a later plan
/// knows which manifest version the base already carries (monotonic check) without reading records.</summary>
public sealed record AccessMarker(int ManifestVersion, string ModuleDigest)
{
    private static readonly Regex Shape = new(@"ssam-access manifestVersion=(\d+) moduleDigest=([0-9a-f]{64})", RegexOptions.Compiled);
    public string Text => $"ssam-access manifestVersion={ManifestVersion} moduleDigest={ModuleDigest}";
    public static AccessMarker? Parse(string? description)
    {
        var m = Shape.Match(description ?? "");
        return m.Success ? new AccessMarker(int.Parse(m.Groups[1].Value), m.Groups[2].Value) : null;
    }
}

/// <param name="DemoAllowlists">The demo sign-in allowlists of the module, by site property name as the module spells it
/// (DemoLoginUsernames, OpsDemoLoginUsernames), read from their default values in the OML. A null list means the property
/// exists but its default is not a plain text literal, so it cannot be read offline. Whether an account is a demo account
/// is derived from these lists of the owner module of the role, never from the manifest; the generated ReconcileAccess
/// re-checks the same properties (Site.&lt;name&gt;) at run time.</param>
/// <param name="ManifestAttributes">The attributes of an AccessManifest static entity a previous plan left in the base
/// (null when unknown): an update adds the ones a newer generator needs, such as IsDemo.</param>
public sealed record AccessModuleFacts(string Module, string BasePath, string BaseSha256, int? BaseVersion,
    IReadOnlyList<AccessRoleFact> Roles, IReadOnlyDictionary<string, IReadOnlyList<string>?> DemoAllowlists, bool ReferencesUserEntity, bool ReferencesEncryptPassword,
    IReadOnlyDictionary<string, string> ReservedElements, AccessMarker? Marker, IReadOnlyList<string> ManifestRecords,
    IReadOnlyList<string>? ManifestAttributes = null)
{
    /// <summary>Every username of the readable demo allowlists of this module (compared trimmed and case-insensitive, as the
    /// demo sign-in compares them).</summary>
    public IReadOnlySet<string> DemoUsernames { get; } = DemoAllowlists.Values.Where(v => v != null).SelectMany(v => v!)
        .ToHashSet(StringComparer.OrdinalIgnoreCase);

    public bool IsDemo(string username) => DemoUsernames.Contains(username.Trim());
}

/// <summary>Reads roles, the demo allowlist site properties, the references the generated logic needs and any access
/// artifacts a previous plan left, through the same model reader as `inspect --kind Role` (one load per base).</summary>
public static class AccessBaseReader
{
    private static readonly Regex VersionInName = new(@"-v(\d+)$", RegexOptions.Compiled);

    /// <summary>The site properties that list the accounts anyone may sign in as without a password: a client's demo
    /// sign-in (DemoLoginUsernames) and the AgentOps one (OpsDemoLoginUsernames, an operations core module).</summary>
    public static readonly IReadOnlyList<string> DemoAllowlistProperties = ["DemoLoginUsernames", "OpsDemoLoginUsernames"];

    public static AccessModuleFacts Read(ModelHost host, string omlPath)
    {
        var full = Path.GetFullPath(omlPath);
        if (!File.Exists(full)) throw new FileNotFoundException("base OML not found: " + full);
        var bytes = File.ReadAllBytes(full);
        var sha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();
        var module = host.Load(bytes);
        try
        {
            var root = (IObjectSignature)module;
            var reader = new KernelModelReader();
            JsonObject Query(string kind, string? name = null)
                => JsonSerializer.SerializeToNode(reader.Read(root, "/", new ReadingOptions(Depth: 0, Max: 500, Kind: kind, Name: name)))!.AsObject();
            JsonObject Tree(string path, int depth)
                => JsonSerializer.SerializeToNode(reader.Read(root, path, new ReadingOptions(Depth: depth, Max: 500)))!.AsObject();
            static IEnumerable<JsonObject> TopLevel(JsonObject result, string kind)
                => (result["entries"]?.AsArray() ?? new JsonArray()).OfType<JsonObject>()
                    .Where(e => e["path"]?.ToString() is { } p && !p.Contains('/') && p.StartsWith(kind + ":", StringComparison.Ordinal));
            static string? Prop(JsonObject e, string name) => e["properties"]?[name]?.ToString();
            static string? ActionName(string? value) => value == null ? null : value.Contains(':') ? value[(value.IndexOf(':') + 1)..] : value;

            var roles = TopLevel(Query("Role"), "Role").Select(e => new AccessRoleFact(e["name"]!.ToString(),
                string.Equals(Prop(e, "IsPersistent"), "True", StringComparison.OrdinalIgnoreCase),
                ActionName(Prop(e, "CheckRoleAction")), ActionName(Prop(e, "GrantRoleAction")), ActionName(Prop(e, "RevokeRoleAction"))))
                .OrderBy(r => r.Name, StringComparer.Ordinal).ToList();

            var demo = new Dictionary<string, IReadOnlyList<string>?>(StringComparer.OrdinalIgnoreCase);
            foreach (var name in DemoAllowlistProperties)
            {
                // exact name: a name filter may also match OpsDemoLoginUsernames when asked for DemoLoginUsernames. The key is
                // the module's own spelling, because the generated guard reads it as Site.<name>.
                var property = TopLevel(Query("SiteProperty", name), "SiteProperty")
                    .FirstOrDefault(e => string.Equals(e["name"]?.ToString(), name, StringComparison.OrdinalIgnoreCase));
                if (property != null) demo[property["name"]!.ToString()] = ParseAllowlist(Prop(property, "DefaultValue"));
            }

            var references = TopLevel(Query("Reference"), "Reference").Select(e => e["name"]!.ToString()).ToHashSet(StringComparer.OrdinalIgnoreCase);
            bool Child(string reference, string kind, string name)
            {
                if (!references.Contains(reference)) return false;
                var tree = Tree("Reference:" + reference, 1)["tree"]?.AsObject();
                return (tree?["children"]?.AsArray() ?? new JsonArray()).OfType<JsonObject>()
                    .Any(c => c["kind"]?.ToString() == kind && string.Equals(c["name"]?.ToString(), name, StringComparison.OrdinalIgnoreCase));
            }

            var reserved = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var name in AccessPlanner.ReservedNames)
                foreach (var hit in (Query("*", name)["entries"]?.AsArray() ?? new JsonArray()).OfType<JsonObject>())
                    if (hit["path"]?.ToString() is { } p && !p.Contains('/')) reserved[name] = hit["kind"]!.ToString();

            AccessMarker? marker = null; var records = new List<string>(); List<string>? attributes = null;
            if (reserved.TryGetValue(AccessPlanner.ManifestEntity, out var manifestKind) && manifestKind == "StaticEntity")
            {
                var tree = Tree("StaticEntity:" + AccessPlanner.ManifestEntity, 1)["tree"]!.AsObject();
                marker = AccessMarker.Parse(tree["properties"]?["Description"]?.ToString());
                var children = (tree["children"]?.AsArray() ?? new JsonArray()).OfType<JsonObject>().ToList();
                records.AddRange(children.Where(c => c["kind"]?.ToString() == "Record").Select(c => c["name"]!.ToString()));
                attributes = children.Where(c => c["kind"]?.ToString() == "EntityAttribute").Select(c => c["name"]!.ToString()).ToList();
            }

            var stem = Path.GetFileNameWithoutExtension(full);
            var version = VersionInName.Match(stem) is { Success: true } vm ? int.Parse(vm.Groups[1].Value) : (int?)null;
            return new AccessModuleFacts(ModelHost.Prop(module, "Name")?.ToString() ?? stem, full, sha, version, roles, demo,
                Child("(System)", "ServerEntitySignature", "User"), Child("Users", "ServerActionSignature", "EncryptPassword"),
                reserved, marker, records, attributes);
        }
        finally { ModelHost.Release(module); }
    }

    /// <summary>The usernames of a comma-separated allowlist default. Only an empty default or one plain text literal can be
    /// read offline; anything else (an expression) gives null, and no account of that list counts as demo.</summary>
    public static IReadOnlyList<string>? ParseAllowlist(string? defaultValue)
    {
        var text = (defaultValue ?? "").Trim();
        if (text.Length == 0) return [];
        if (text.Length < 2 || text[0] != '"' || text[^1] != '"') return null;
        var inner = text[1..^1];
        if (inner.Replace("\"\"", "").Contains('"')) return null; // a concatenation such as "a" + "b", not one literal
        return inner.Replace("\"\"", "\"").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();
    }

    public const string AllowlistNormalization = "items trimmed, lower-cased, without empty items and duplicates, sorted (ordinal), joined by \\n; sha256 hex of the UTF-8 text";

    /// <summary>The sha256 of one allowlist, normalized as <see cref="AllowlistNormalization"/> says, so the same set of
    /// usernames gives the same digest whatever its order, spacing or case. It identifies the list the plan derived
    /// "demo" from; it is not a secret (a dictionary of demo names reverses it, as it does the username hashes).</summary>
    public static string AllowlistSha256(IEnumerable<string> items)
        => AccessManifest.Hash(string.Join("\n", items.Select(i => i.Trim().ToLowerInvariant()).Where(i => i.Length > 0)
            .Distinct(StringComparer.Ordinal).OrderBy(i => i, StringComparer.Ordinal)));
}
