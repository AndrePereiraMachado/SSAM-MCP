using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;

namespace Anvil.Cli;

/// <summary>`users`: the read-only lookup of users and roles through the Studio already logged in on the lane (A13, MCP
/// o11_access {action:"users"}). Always a read-only lease; never --credentials.
///   users [--host h] [--email e] [--username u] [--role r] [--max n] [--work dir]
/// The bridge must serve environment_session users-read (UserDirectory): an older bridge is refused with
/// STUDIO_BRIDGE_OUTDATED before any read. The attribute keys of User, Role and User_Role come from the (System)
/// references of the published Users module, downloaded once per Users version and kept as a small schema file under
/// &lt;work&gt;; the entity keys are checked against the platform's own constants. Only the closed list of attributes
/// (id, username, name, email, active, role names) is ever read; the password and its hash never leave the Studio.</summary>
internal static class UsersCommand
{
    public static JsonObject Run(string[] args, Func<string[], HeadlessSession> connect)
    {
        string? Opt(string name) { var i = Array.IndexOf(args, name); return i >= 0 && i + 1 < args.Length ? args[i + 1] : null; }
        if (args.Contains("--credentials")) throw new ArgumentException("users runs only through the Studio's own login; --credentials is refused");
        var max = int.TryParse(Opt("--max"), out var m) ? m : 20;
        var query = new UserDirectory.UsersQuery(Opt("--email"), Opt("--username"), Opt("--role"), max);
        var work = Path.GetFullPath(Opt("--work") ?? ".local/users");
        using var session = connect(args.Contains("--read-only") ? args : [.. args, "--read-only"]);
        if (!session.Serves(UserDirectory.Operation))
            throw new KernelRefusalException("STUDIO_BRIDGE_OUTDATED", "The bridge loaded in the Studio has no users lookup (" + UserDirectory.Capability + "); open the Service Studio through the \"Service Studio (SSAM)\" shortcut so the current bridge loads, then reconnect it; nothing was read");
        var schema = Schema(session, work);
        var answer = UserDirectory.Lookup(schema, request => session.ReadDirectory(request), query);
        answer["host"] = session.Host;
        if (query.Max != query.Bounded) answer["maxAdjusted"] = new JsonObject { ["from"] = query.Max, ["to"] = query.Bounded };
        return answer;
    }

    private static UserDirectory.DirectorySchema Schema(HeadlessSession session, string work)
    {
        var usersKey = UserDirectory.UsersModuleKey;
        var users = session.ListModules().FirstOrDefault(x => SameKey(x.Key, usersKey)) ?? session.ListModules(refresh: true).FirstOrDefault(x => SameKey(x.Key, usersKey))
            ?? throw new KernelRefusalException("USERS_MODULE_NOT_FOUND", "The Users module is not published in " + session.Host + "; nothing was read");
        var cache = Path.Combine(work, "schema-" + Safe(session.Host) + "-" + users.VersionId + ".json");
        if (File.Exists(cache))
        {
            try
            {
                var cached = JsonSerializer.Deserialize<UserDirectory.DirectorySchema>(File.ReadAllText(cache));
                if (cached != null && UserDirectory.Check(cached, UserDirectory.EntityKeys).Count == 0) return cached;
            }
            catch (JsonException) { }
        }
        var folder = Path.Combine(work, "download", users.VersionId.ToString());
        var download = session.Download(users, folder);
        if (download.FilePath == null || !File.Exists(download.FilePath))
            throw new KernelRefusalException("USERS_MODULE_NOT_FOUND", "The published Users module could not be downloaded: " + download.Status + "; nothing was read");
        var schema = UserDirectory.SchemaFromOml(new ModelHost(Path.Combine(work, "model")), download.FilePath);
        var problems = schema == null ? ["the Users module does not reference User, Role and User_Role of (System)"] : UserDirectory.Check(schema, UserDirectory.EntityKeys);
        if (schema == null || problems.Count > 0)
            throw new KernelRefusalException("USERS_SCHEMA_UNRESOLVED", "The (System) user entities could not be resolved from the published Users module: " + string.Join("; ", problems) + "; nothing was read",
                new JsonArray(problems.Select(p => (JsonNode)new JsonObject { ["code"] = "USERS_SCHEMA_UNRESOLVED", ["message"] = p }).ToArray()));
        Directory.CreateDirectory(work);
        File.WriteAllText(cache, JsonSerializer.Serialize(schema));
        return schema;
    }

    private static bool SameKey(string? a, string b) { try { return a != null && Keys.ToStudio(a) == b; } catch (FormatException) { return false; } }
    private static string Safe(string text) => string.Concat(text.Select(c => char.IsLetterOrDigit(c) || c is '.' or '-' ? c : '_'));
}
