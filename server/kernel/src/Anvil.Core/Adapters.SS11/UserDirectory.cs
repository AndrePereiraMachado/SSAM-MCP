using System.Text.Json.Nodes;
using OutSystems.Model;
using OutSystems.RuntimeCommon;
using ServiceStudio.ServerCommunications;

namespace Anvil.Core;

/// <summary>
/// A13 (package of 2026-10-06): a read-only lookup of the platform's users and roles through the Studio's own login, so
/// a session never asks the user for a numeric user id nor opens the Users app in a browser. It reads the (System)
/// entities User, Role and User_Role with Service Studio's Edit Data (GetRecords), with a CLOSED attribute list per
/// entity: id, username, name, email, active and role names. Never the password or its hash: the Studio side projects
/// every row to the requested attribute keys before anything leaves the Studio, and the names it accepts are only the
/// closed list. Edit Data of (System) and Users stays refused for everything else (EnvironmentData.IsRefusedModule) and
/// for every write. Bridge capability environment_session:users-read; an older bridge has no such operation and the CLI
/// refuses with STUDIO_BRIDGE_OUTDATED before any call.
///
/// The entity keys are the platform's own constants (OutSystems.RuntimeCommon.Constants.User_Key, Role_Key, User_Role_Key;
/// the (System) entities live in the ServiceCenter eSpace). The attribute keys come from the (System) references of the
/// published Users module (FromModel), the same source the Studio uses.
/// </summary>
public static class UserDirectory
{
    public const string Operation = "users-read";
    public const string Capability = "environment_session:" + Operation;
    public const string UserEntity = "User", RoleEntity = "Role", UserRoleEntity = "User_Role";

    /// <summary>The closed attribute lists. Nothing else is ever projected.</summary>
    public static readonly IReadOnlyDictionary<string, string[]> Attributes = new Dictionary<string, string[]>(StringComparer.Ordinal)
    {
        [UserEntity] = ["Id", "Username", "Name", "Email", "Is_Active"],
        [RoleEntity] = ["Id", "Name"],
        [UserRoleEntity] = ["User_Id", "Role_Id"],
    };

    /// <summary>Attribute names that never leave the Studio, whatever a caller asks (defense in depth over the closed list).</summary>
    public static readonly string[] Never = ["Password", "Password_Hash", "PasswordHash", "Hash", "Salt"];

    /// <summary>Most rows one users-read call scans (Edit Data pages through offset).</summary>
    public const int MaxScan = 20000;

    public sealed record EntitySchema(string Name, string Key, IReadOnlyDictionary<string, string> AttributeKeys);
    public sealed record DirectorySchema(string ModuleKey, IReadOnlyDictionary<string, EntitySchema> Entities);
    public sealed record ReadResult(IReadOnlyList<JsonObject> Rows, int Scanned, bool Complete);

    /// <summary>The owner of the (System) entities and the platform keys of the three entities, in database form.</summary>
    public static string SystemModuleKey => Keys.ToDb(Constants.ServiceCenterESpaceKey.ToString());
    public static IReadOnlyDictionary<string, string> EntityKeys => new Dictionary<string, string>(StringComparer.Ordinal)
    {
        [UserEntity] = Keys.ToDb(Constants.User_Key.ToString()),
        [RoleEntity] = Keys.ToDb(Constants.Role_Key.ToString()),
        [UserRoleEntity] = Keys.ToDb(Constants.User_Role_Key.ToString()),
    };

    // ---- the checks both sides run (pure) ---------------------------------------------------------------------------

    /// <summary>The entity a key names among the three, or null. Keys compare in their canonical form.</summary>
    public static string? EntityOf(string entityKey, IReadOnlyDictionary<string, string> entityKeys)
    {
        string Canonical(string key) { try { return Keys.ToStudio(key); } catch (Exception) { return key; } }
        var wanted = Canonical(entityKey ?? "");
        return entityKeys.FirstOrDefault(e => string.Equals(Canonical(e.Value), wanted, StringComparison.Ordinal)).Key;
    }

    /// <summary>A users-read request refused before any read: an entity other than the three, an attribute outside its
    /// closed list (or in Never), a repeated name or key, or a match on an attribute that is not projected. Null when valid.</summary>
    public static string? Refusal(string? entity, IReadOnlyList<(string Name, string Key)> attributes, string? matchName)
    {
        if (entity == null || !Attributes.TryGetValue(entity, out var allowed)) return "users-read reads only the User, Role and User_Role entities of (System)";
        if (attributes.Count == 0) return "users-read needs the attributes to project";
        foreach (var (name, key) in attributes)
        {
            if (Never.Contains(name, StringComparer.OrdinalIgnoreCase) || !allowed.Contains(name, StringComparer.Ordinal))
                return $"{entity}.{name} is not readable here; readable: {string.Join(", ", allowed)}";
            if (string.IsNullOrWhiteSpace(key)) return $"{entity}.{name} has no key";
        }
        if (attributes.Select(a => a.Name).Distinct(StringComparer.Ordinal).Count() != attributes.Count) return "attribute names repeat";
        if (attributes.Select(a => a.Key).Distinct(StringComparer.Ordinal).Count() != attributes.Count) return "attribute keys repeat";
        if (matchName != null && !attributes.Any(a => a.Name == matchName)) return "match names an attribute that is not projected: " + matchName;
        return null;
    }

    /// <summary>One page of Edit Data rows projected to the requested attributes: {id, values:{name:value}}; a cell whose key
    /// is not requested never enters the result. match: keep rows whose attribute equals one of the values (case-insensitive).</summary>
    public static IEnumerable<JsonObject> Project(IEnumerable<EnvironmentData.Row> rows, IReadOnlyList<(string Name, string Key)> attributes,
        string? matchName = null, IReadOnlyCollection<string>? matchValues = null)
    {
        string Canonical(string key) { try { return Keys.ToStudio(key); } catch (Exception) { return key; } }
        var byKey = attributes.ToDictionary(a => Canonical(a.Key), a => a.Name, StringComparer.Ordinal);
        var wanted = matchValues == null ? null : new HashSet<string>(matchValues, StringComparer.OrdinalIgnoreCase);
        foreach (var row in rows)
        {
            var values = new JsonObject();
            foreach (var cell in row.Attributes)
                if (byKey.TryGetValue(Canonical(cell.Key), out var name)) values[name] = cell.Value;
            var candidate = matchName == null ? null : values[matchName]?.GetValue<string>() ?? (matchName == "Id" ? row.Id : null);
            if (matchName != null && wanted != null && !(candidate != null && wanted.Contains(candidate))) continue;
            yield return new JsonObject { ["id"] = row.Id, ["values"] = values };
        }
    }

    // ---- Studio side (bridge, environment_session) -------------------------------------------------------------------

    /// <summary>users-read {entityKey, attributes:[{name, key}], match?:{name, values}, maxRows?}: pages GetRecords of one of the
    /// three entities until maxRows matching rows, the end, or MaxScan rows scanned, and answers only projected rows.</summary>
    public static object Execute(HeadlessSession session, JsonObject? arguments)
    {
        // The request is checked before the provider is touched: a refused one reads nothing.
        var entityKey = arguments?["entityKey"]?.GetValue<string>() ?? "";
        var entity = EntityOf(entityKey, EntityKeys);
        var attributes = (arguments?["attributes"] as JsonArray ?? []).Select(a => (a?["name"]?.GetValue<string>() ?? "", a?["key"]?.GetValue<string>() ?? "")).ToArray();
        var matchName = arguments?["match"]?["name"]?.GetValue<string>();
        var matchValues = (arguments?["match"]?["values"] as JsonArray)?.Select(v => v?.GetValue<string>() ?? "").ToArray();
        if (Refusal(entity, attributes, matchName) is { } refused) throw new KernelRefusalException("USERS_READ_REFUSED", refused);
        var provider = session.StudioProvider as ServerCommunicationsProvider
            ?? throw new InvalidOperationException("The Studio data provider is unavailable for this lease");
        var maxRows = Math.Clamp(arguments?["maxRows"]?.GetValue<int>() ?? MaxScan, 1, MaxScan);
        var read = Read((offset) => (provider.GetRecords(SystemModuleKey, EntityKeys[entity!], null, null, false, false, offset)
                ?? throw new InvalidOperationException("The environment does not advertise Edit Data (EditDataV4)"))
            .Select(r => new EnvironmentData.Row(r.Id, (r.EntityAttributesInfo ?? []).Select(a => new EnvironmentData.Cell(a.Key, a.Value)).ToArray())).ToArray(),
            attributes, matchName, matchValues, maxRows);
        return new JsonObject { ["entity"] = entity, ["rows"] = new JsonArray(read.Rows.Select(r => (JsonNode)r).ToArray()),
            ["scanned"] = read.Scanned, ["complete"] = read.Complete };
    }

    /// <summary>The paging loop of Execute over any page reader (offset -> rows), for the tests.</summary>
    public static ReadResult Read(Func<int, EnvironmentData.Row[]> page, IReadOnlyList<(string Name, string Key)> attributes,
        string? matchName, IReadOnlyCollection<string>? matchValues, int maxRows)
    {
        var rows = new List<JsonObject>(); var scanned = 0;
        while (scanned < MaxScan)
        {
            var batch = page(scanned);
            if (batch.Length == 0) return new(rows, scanned, true);
            scanned += batch.Length;
            foreach (var row in Project(batch, attributes, matchName, matchValues))
            {
                rows.Add(row);
                if (rows.Count >= maxRows) return new(rows, scanned, false);
            }
        }
        return new(rows, scanned, false);
    }

    // ---- CLI side -----------------------------------------------------------------------------------------------------

    /// <summary>The question: by email, by username, by role name, or the first users; Max users answered (1..100).</summary>
    public sealed record UsersQuery(string? Email, string? Username, string? Role, int Max = 20)
    {
        public const int Limit = 100;
        public int Bounded => Math.Clamp(Max, 1, Limit);
    }

    /// <summary>The answer of the lookup over any users-read reader (the Studio lease in the CLI, a fake in the tests):
    /// {users:[{id, username, name, email, isActive, roles}], total, ...}. Only the closed-list values reach it.</summary>
    public static JsonObject Lookup(DirectorySchema schema, Func<JsonObject, JsonObject> read, UsersQuery query)
    {
        JsonObject Read(string entity, string? matchName, IEnumerable<string>? matchValues, int maxRows)
        {
            var e = schema.Entities[entity];
            var request = new JsonObject
            {
                ["entityKey"] = e.Key,
                ["attributes"] = new JsonArray(Attributes[entity].Where(e.AttributeKeys.ContainsKey)
                    .Select(n => (JsonNode)new JsonObject { ["name"] = n, ["key"] = e.AttributeKeys[n] }).ToArray()),
                ["maxRows"] = maxRows,
            };
            if (matchName != null) request["match"] = new JsonObject { ["name"] = matchName, ["values"] = new JsonArray(matchValues!.Select(v => (JsonNode)v).ToArray()) };
            return read(request);
        }
        static IEnumerable<JsonObject> Rows(JsonObject answer) => (answer["rows"] as JsonArray ?? []).OfType<JsonObject>();
        static string? Value(JsonObject row, string name) => row["values"]?[name]?.GetValue<string>();
        static string Id(JsonObject row) => Value(row, "Id") ?? row["id"]?.GetValue<string>() ?? "";

        var roles = Rows(Read(RoleEntity, null, null, MaxScan)).ToDictionary(Id, r => Value(r, "Name") ?? "", StringComparer.Ordinal);
        var max = query.Bounded;
        var notes = new JsonObject();
        JsonObject usersAnswer;
        int total;
        if (!string.IsNullOrWhiteSpace(query.Email) || !string.IsNullOrWhiteSpace(query.Username))
        {
            usersAnswer = !string.IsNullOrWhiteSpace(query.Email) ? Read(UserEntity, "Email", [query.Email!.Trim()], MaxScan) : Read(UserEntity, "Username", [query.Username!.Trim()], MaxScan);
            var matched = Rows(usersAnswer).Where(u => string.IsNullOrWhiteSpace(query.Username) || string.Equals(Value(u, "Username"), query.Username!.Trim(), StringComparison.OrdinalIgnoreCase)).ToArray();
            total = matched.Length;
            usersAnswer = new JsonObject { ["rows"] = new JsonArray(matched.Take(max).Select(r => r.DeepClone()).ToArray()), ["complete"] = usersAnswer["complete"]?.DeepClone() };
        }
        else if (!string.IsNullOrWhiteSpace(query.Role))
        {
            var roleIds = roles.Where(r => string.Equals(r.Value, query.Role!.Trim(), StringComparison.OrdinalIgnoreCase)).Select(r => r.Key).ToArray();
            if (roleIds.Length == 0)
                return new JsonObject { ["ok"] = true, ["users"] = new JsonArray(), ["total"] = 0, ["unknownRole"] = query.Role,
                    ["roles"] = new JsonArray(roles.Values.Where(n => n.Length > 0).Order(StringComparer.OrdinalIgnoreCase).Take(50).Select(n => (JsonNode)n).ToArray()) };
            var links = Read(UserRoleEntity, "Role_Id", roleIds, MaxScan);
            var userIds = Rows(links).Select(l => Value(l, "User_Id")).OfType<string>().Distinct(StringComparer.Ordinal).ToArray();
            total = userIds.Length;
            if (links["complete"]?.GetValue<bool>() == false) notes["linksTruncated"] = true;
            usersAnswer = userIds.Length == 0 ? new JsonObject { ["rows"] = new JsonArray(), ["complete"] = true }
                : Read(UserEntity, "Id", userIds.Take(MaxScan), max);
        }
        else
        {
            usersAnswer = Read(UserEntity, null, null, max);
            total = Rows(usersAnswer).Count();
            if (usersAnswer["complete"]?.GetValue<bool>() == false) notes["more"] = true;
        }
        var users = Rows(usersAnswer).Take(max).ToArray();
        var byUser = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        if (users.Length > 0)
            foreach (var link in Rows(Read(UserRoleEntity, "User_Id", users.Select(Id), MaxScan)))
                if (Value(link, "User_Id") is { } u && Value(link, "Role_Id") is { } r && roles.TryGetValue(r, out var roleName))
                    (byUser.TryGetValue(u, out var list) ? list : byUser[u] = []).Add(roleName);
        var answer = new JsonObject
        {
            ["ok"] = true,
            ["users"] = new JsonArray(users.Select(u => (JsonNode)new JsonObject
            {
                ["id"] = Id(u), ["username"] = Value(u, "Username"), ["name"] = Value(u, "Name"), ["email"] = Value(u, "Email"),
                ["isActive"] = bool.TryParse(Value(u, "Is_Active"), out var active) ? active : null,
                ["roles"] = new JsonArray((byUser.TryGetValue(Id(u), out var names) ? names : []).Distinct(StringComparer.Ordinal)
                    .Order(StringComparer.OrdinalIgnoreCase).Select(n => (JsonNode)n).ToArray()),
            }).ToArray()),
            ["total"] = total,
        };
        foreach (var (key, value) in notes) answer[key] = value?.DeepClone();
        return answer;
    }

    /// <summary>The key of the platform's Users module (Studio form): its published OML references the three entities.</summary>
    public static string UsersModuleKey => Keys.ToStudio(Constants.UsersESpaceKey.ToString());

    /// <summary>FromModel over a saved OML (the published Users module), released after the read.</summary>
    public static DirectorySchema? SchemaFromOml(ModelHost host, string oml)
    {
        var model = host.Load(oml);
        try { return FromModel((IESpace)model); }
        finally { ModelHost.Release(model); }
    }

    /// <summary>The attribute keys of User, Role and User_Role from the (System) references of a module (the published Users
    /// module references all three), in database form. Only the closed-list names are kept. Null when an entity is absent.</summary>
    public static DirectorySchema? FromModel(IESpace espace)
    {
        var found = SystemEntitiesOf(espace);
        return Attributes.Keys.All(found.ContainsKey) ? new DirectorySchema(SystemModuleKey, found) : null;
    }

    /// <summary>The (System) entities of the closed list a module references, with the closed-list attributes it carries
    /// (a reference holds only the attributes the module uses; Check names what is missing).</summary>
    public static IReadOnlyDictionary<string, EntitySchema> SystemEntitiesOf(IESpace espace)
    {
        var systemKey = Keys.ToStudio(Constants.ServiceCenterESpaceKey.ToString());
        var found = new Dictionary<string, EntitySchema>(StringComparer.Ordinal);
        foreach (var reference in espace.References)
        {
            string? producer = null;
            try { producer = ModelHost.Prop(reference, "ReferenceKey")?.ToString() is { Length: > 0 } key ? Keys.ToStudio(key) : null; } catch (FormatException) { }
            if (producer != systemKey) continue;
            foreach (var e in reference.Entities)
            {
                var name = TypeResolver.Name(e);
                if (name == null || !Attributes.TryGetValue(name, out var allowed) || found.ContainsKey(name)) continue;
                // A reference element has its own Key; OriginalKey is the producer's key, the one Edit Data takes. A hidden Id
                // ("<entity>.#HiddenReferenceEntity_Id") is not an attribute key: Edit Data answers it as the record id.
                var keys = new Dictionary<string, string>(StringComparer.Ordinal);
                foreach (var a in (ModelHost.Prop(e, "Attributes") as System.Collections.IEnumerable)?.Cast<object>() ?? [])
                    if (TypeResolver.Name(a) is { } attr && allowed.Contains(attr, StringComparer.Ordinal) && ProducerKey(a) is { } k && !k.Contains('#'))
                        keys[attr] = Keys.ToDb(k);
                if (ProducerKey(e) is { } entityKey) found[name] = new EntitySchema(name, Keys.ToDb(entityKey), keys);
            }
        }
        return found;
    }

    private static string? ProducerKey(object element) =>
        (ModelHost.Prop(element, "OriginalKey") ?? (element as IObjectSignature)?.ObjectKey)?.ToString() is { Length: > 0 } key ? key : null;

    /// <summary>SystemEntitiesOf over a saved OML, released after the read.</summary>
    public static IReadOnlyDictionary<string, EntitySchema> SystemEntitiesOfOml(ModelHost host, string oml)
    {
        var model = host.Load(oml);
        try { return SystemEntitiesOf((IESpace)model); }
        finally { ModelHost.Release(model); }
    }

    /// <summary>The schema checked against the platform constants: every entity key must be the platform's own and every
    /// attribute of the closed list present. Returns the problems (empty when usable).</summary>
    public static IReadOnlyList<string> Check(DirectorySchema schema, IReadOnlyDictionary<string, string> entityKeys)
    {
        var problems = new List<string>();
        foreach (var (name, allowed) in Attributes)
        {
            if (!schema.Entities.TryGetValue(name, out var e)) { problems.Add("(System) " + name + " is not referenced by the Users module"); continue; }
            if (EntityOf(e.Key, entityKeys) != name) problems.Add($"(System) {name} has key {e.Key}, not the platform's own");
            // Id may be hidden in a reference: Edit Data answers the record id with every row (Lookup reads it there).
            foreach (var attr in allowed.Where(a => a != "Id")) if (!e.AttributeKeys.ContainsKey(attr)) problems.Add($"(System) {name}.{attr} is not in the Users module reference");
        }
        return problems;
    }
}
