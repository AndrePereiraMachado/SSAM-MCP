using System.Text.Json.Nodes;

namespace Anvil.Core.Access;

public sealed record AccessPlanOptions(bool CreateAccounts = false, bool CreateActive = false, bool HasUsersProducer = false);

/// <summary>Last delivered state of one owner module, from the local ledger written by `access apply --execute`.</summary>
public sealed record AccessLedgerEntry(int ManifestVersion, string ModuleDigest, string OperationId);

public sealed record AccessModulePlan(string Module, string Status, string Mode, string ModuleDigest, JsonObject? Job,
    IReadOnlyList<string> Checks, IReadOnlyList<string> Roles, int Grants, int Revokes, int Creates, bool NeedsUsersProducer);

public sealed record AccessPlanResult(IReadOnlyList<string> Errors, IReadOnlyList<string> Warnings, IReadOnlyList<AccessModulePlan> Modules)
{
    public bool Ok => Errors.Count == 0;
}

/// <summary>
/// Validates an access manifest against the owner modules and generates ONE job per owner module (option A of the design,
/// with the opt-in account creation of option D). Pure: the same manifest, facts and options give the same jobs, byte for
/// byte, so a plan can be re-proved and its job hash compared before delivery.
///
/// The generated module surface is private: static AccessManifest (the manifest rows of that module, each marked IsDemo as
/// the plan derived it), AccessState (last applied version, refuses downgrade), AccessAudit (UserId, RoleCode, Action,
/// Outcome, ManifestVersion, AuthorizationDigest, Trigger, AtUtc; no names or emails), WriteAccessAudit, ReconcileAccess
/// (find by username in (System) User, skip inactive, Check then Grant/Revoke through a Switch over the fixed allowlist of
/// the roles this manifest names), two timer entries (When Published, and on demand through Service Center Run Now) and,
/// only when opted in, CreateMissingUser.
///
/// Run-time demo guard (K2 review, B6 follow-up): the plan derives "demo" from the allowlist defaults of the base OML, and a
/// base is only a file the manifest names. So ReconcileAccess re-checks the module's own Site.DemoLoginUsernames /
/// Site.OpsDemoLoginUsernames (the values in force in the environment, compared as the demo sign-in compares them) before
/// CreateMissingUser and before granting a role to a row marked demo; an unlisted row is audited NotDemoListed and nothing
/// is created or granted. Revokes are never blocked.
/// </summary>
public static class AccessPlanner
{
    public const string ManifestEntity = "AccessManifest", StateEntity = "AccessState", AuditEntity = "AccessAudit", RandomStructure = "AccessRandomText";
    public const string WriteAudit = "WriteAccessAudit", Reconcile = "ReconcileAccess", CreateUser = "CreateMissingUser";
    public const string TickPublish = "RunAccessReconcileOnPublish", TickDemand = "RunAccessReconcileOnDemand";
    public const string TimerPublish = "AccessReconcileOnPublish", TimerDemand = "AccessReconcileOnDemand";
    // /2: IsDemo rows and the run-time allowlist guard. The generator is part of the module digest, so a module already
    // carrying /1 logic for the same manifestVersion is refused ("raise manifestVersion") instead of being called unchanged.
    public const string Generator = "ssam-access-generator/2";
    public const string DemoAttribute = "IsDemo", NotDemoListed = "NotDemoListed";
    public static readonly IReadOnlyList<string> ReservedNames =
        [ManifestEntity, StateEntity, AuditEntity, RandomStructure, WriteAudit, Reconcile, CreateUser, TickPublish, TickDemand, TimerPublish, TimerDemand];

    // Never managed here: the Users application and platform modules own their roles, and UserManager/SuperUser would
    // let an account administer every other account.
    private static readonly HashSet<string> DeniedModules = new(StringComparer.OrdinalIgnoreCase)
        { "Users", "UsersServices", "UsersLibrary", "UsersSecurity", "(System)", "System", "ServiceCenter", "LifeTime", "LifeTimeSDK", "OutSystemsUI" };
    private static readonly HashSet<string> DeniedRoles = new(StringComparer.OrdinalIgnoreCase)
        { "UserManager", "SuperUser", "Registered", "Anonymous" };
    private const string Cur = "ReadManifest.List.Current." + ManifestEntity;

    /// <summary>A module whose roles are never managed here needs no base: the plan refuses it by this rule first.</summary>
    public static bool IsDeniedModule(string module) => DeniedModules.Contains(module);

    public static AccessPlanResult Plan(AccessManifest manifest, IReadOnlyDictionary<string, AccessModuleFacts> facts,
        AccessPlanOptions options, IReadOnlyDictionary<string, AccessLedgerEntry>? ledger = null)
    {
        var errors = new List<string>(); var warnings = new List<string>();
        string H(AccessEntry e) => AccessManifest.UsernameHash(manifest.Environment, e.Username);

        // Demo is DERIVED, never trusted from the manifest: an account is a demo account only when its username is in a demo
        // sign-in allowlist (DemoLoginUsernames / OpsDemoLoginUsernames defaults read from the OML) of the owner module of
        // the role. The manifest's own flag must agree, or the entry is refused.
        var resolved = new List<(AccessEntry Entry, AccessRoleFact Role)>();
        foreach (var e in manifest.Entries)
        {
            var at = $"{e.Qualified} (user hash {H(e)})";
            if (DeniedModules.Contains(e.Module)) { errors.Add($"{at}: roles of module {e.Module} are never managed by ssam access (Users and platform modules are out of scope)"); continue; }
            if (DeniedRoles.Contains(e.Role)) { errors.Add($"{at}: role {e.Role} is never granted or revoked by ssam access (UserManager, SuperUser and system roles are out of scope)"); continue; }
            if (!facts.TryGetValue(e.Module, out var module)) { errors.Add($"{at}: no base for module {e.Module}; add \"bases\": {{\"{e.Module}\": \"<current OML>\"}} to the manifest or --module-base {e.Module}=<oml>"); continue; }
            var role = module.Roles.FirstOrDefault(r => string.Equals(r.Name, e.Role, StringComparison.OrdinalIgnoreCase));
            if (role == null)
            {
                var owners = facts.Values.Where(f => f.Roles.Any(r => string.Equals(r.Name, e.Role, StringComparison.OrdinalIgnoreCase))).Select(f => f.Module).ToList();
                errors.Add($"{at}: {e.Role} is not a role defined in {e.Module} (its roles: {string.Join(", ", module.Roles.Select(r => r.Name))})"
                    + (owners.Count > 0 ? $"; the owner module is {string.Join(" or ", owners)}" : "; referenced roles are managed in their owner module"));
                continue;
            }
            if (!role.IsPersistent) { errors.Add($"{at}: role {role.Name} is not persistent; only persistent roles can be granted outside a session"); continue; }
            if (role.Name.Length > 50) { errors.Add($"{at}: role name {role.Name} is longer than the 50 characters of AccessManifest.RoleCode"); continue; }
            if (role.CheckAction == null || role.GrantAction == null || role.RevokeAction == null) { errors.Add($"{at}: role {role.Name} has no Check/Grant/Revoke actions in the base"); continue; }
            var isDemo = module.IsDemo(e.Username);
            if (e.Demo && !isDemo)
            {
                var elsewhere = facts.Values.Where(f => !ReferenceEquals(f, module) && f.IsDemo(e.Username)).Select(f => f.Module).ToList();
                errors.Add($"{at}: marked demo, but the username is not in {AllowlistText(module)} of {module.Module}; demo is derived from the owner module of the role, not from the manifest"
                    + (elsewhere.Count > 0 ? $" (it is in the allowlist of {string.Join(", ", elsewhere)}, which does not own {e.Role})" : "")
                    + "; add it to the site property default and download the module again, or mark it demo:false");
            }
            if (!e.Demo && isDemo)
                errors.Add($"{at}: a non-demo account is listed in the demo sign-in allowlist of {module.Module}, so any visitor could sign in as it while the demo login is on; remove it from the site property or mark it demo");
            if (!isDemo && !e.Demo && !manifest.AllowNonDemoAccounts)
                errors.Add($"{at}: non-demo account refused: its username would be stored in the published module (static {ManifestEntity}); phase 1 manages demo accounts only (set allowNonDemoAccounts:true to accept that exposure)");
            if (e.Grant && isDemo && role.Name.Contains("Admin", StringComparison.OrdinalIgnoreCase))
                warnings.Add($"{at}: administrative role granted to a demo account; with the demo login on, any visitor can act as this administrator");
            if (e.CreateIfMissing && !options.CreateAccounts)
                errors.Add($"{at}: createIfMissing requires the explicit opt-in --create-accounts of plan (off by default)");
            if (e.CreateIfMissing && !isDemo)
                errors.Add($"{at}: account creation is limited to the usernames of the demo sign-in allowlist of {module.Module} ({AllowlistText(module)})");
            resolved.Add((e, role));
        }
        if (manifest.AllowNonDemoAccounts && resolved.Any(r => !facts[r.Entry.Module].IsDemo(r.Entry.Username)))
            warnings.Add("allowNonDemoAccounts: usernames of non-demo accounts will be stored in the published modules; prefer the phase 2 channel for people");
        if (resolved.Any(r => r.Entry.Grant && facts[r.Entry.Module].IsDemo(r.Entry.Username)))
            warnings.Add("roles granted to demo accounts are available to any visitor while the demo login is on (IsDemoLoginEnabled / IsOpsDemoLoginEnabled); switch it off after the demo");
        if (options.CreateAccounts && !manifest.Entries.Any(e => e.CreateIfMissing))
            warnings.Add("--create-accounts was given, but no entry has createIfMissing:true; no account creation logic is generated");

        var modules = new List<AccessModulePlan>();
        foreach (var group in resolved.GroupBy(r => r.Entry.Module, StringComparer.OrdinalIgnoreCase).OrderBy(g => g.Key, StringComparer.OrdinalIgnoreCase))
        {
            var module = facts[group.Key];
            var rows = group.ToList();
            var creates = options.CreateAccounts && rows.Any(r => r.Entry.CreateIfMissing);
            var digest = ModuleDigest(manifest, module.Module, rows.Select(r => r.Entry), creates, options.CreateActive);
            var at = module.Module;
            if (!module.ReferencesUserEntity)
            {
                errors.Add($"{at}: the module does not reference (System) User; add it in Service Studio (Manage Dependencies > (System) > User) before planning");
                continue;
            }
            var foreign = module.ReservedElements.Where(r => module.Marker == null).Select(r => $"{r.Value} {r.Key}").ToList();
            if (foreign.Count > 0)
            {
                errors.Add($"{at}: names reserved by ssam access already exist and were not generated by it: {string.Join(", ", foreign)}");
                continue;
            }
            var status = "changes";
            if (module.Marker is { } marker)
            {
                if (marker.ManifestVersion > manifest.ManifestVersion)
                { errors.Add($"{at}: downgrade refused: the base carries manifestVersion {marker.ManifestVersion} and this manifest is {manifest.ManifestVersion}"); continue; }
                if (marker.ManifestVersion == manifest.ManifestVersion && marker.ModuleDigest != digest)
                { errors.Add($"{at}: manifestVersion {manifest.ManifestVersion} is already in the base with other content; raise manifestVersion"); continue; }
                if (marker.ModuleDigest == digest) status = "unchanged";
            }
            if (ledger != null && ledger.TryGetValue(module.Module, out var delivered))
            {
                if (delivered.ManifestVersion > manifest.ManifestVersion)
                { errors.Add($"{at}: downgrade refused: operation {delivered.OperationId} already delivered manifestVersion {delivered.ManifestVersion}"); continue; }
                if (delivered.ManifestVersion == manifest.ManifestVersion && delivered.ModuleDigest != digest)
                { errors.Add($"{at}: manifestVersion {manifest.ManifestVersion} was already delivered with other content (operation {delivered.OperationId}); raise manifestVersion"); continue; }
                if (module.Marker == null || module.Marker.ManifestVersion < delivered.ManifestVersion)
                {
                    if (delivered.ModuleDigest == digest) { status = "unchanged"; warnings.Add($"{at}: already delivered by operation {delivered.OperationId}; the base is older than that delivery (publish it and download the current OML)"); }
                    else { errors.Add($"{at}: the base is older than the last delivery (operation {delivered.OperationId}, manifestVersion {delivered.ManifestVersion}); download the current module before planning"); continue; }
                }
            }
            var needsUsers = creates && !module.ReferencesEncryptPassword;
            if (needsUsers && !options.HasUsersProducer)
            { errors.Add($"{at}: account creation needs Users.EncryptPassword; bind the Users module OML with --producer Users=<oml> (download it read-only)"); continue; }
            var roles = rows.Select(r => r.Role).DistinctBy(r => r.Name, StringComparer.OrdinalIgnoreCase).OrderBy(r => r.Name, StringComparer.Ordinal).ToList();
            var job = status == "unchanged" ? null : Job(manifest, module, rows, roles, digest, creates, options.CreateActive, needsUsers);
            modules.Add(new AccessModulePlan(module.Module, status, module.Marker == null ? "create" : "update", digest, job,
                Checks(creates), roles.Select(r => r.Name).ToList(), rows.Count(r => r.Entry.Grant), rows.Count(r => !r.Entry.Grant),
                rows.Count(r => r.Entry.CreateIfMissing && creates), needsUsers));
        }
        return new AccessPlanResult(errors, warnings, errors.Count > 0 ? [] : modules);
    }

    private static string AllowlistText(AccessModuleFacts module) => module.DemoAllowlists.Count == 0
        ? "a demo sign-in allowlist (the module declares neither " + string.Join(" nor ", AccessBaseReader.DemoAllowlistProperties) + ")"
        : string.Join(" or ", module.DemoAllowlists.OrderBy(a => a.Key, StringComparer.Ordinal)
            .Select(a => a.Value == null ? a.Key + " (its default is not one plain text literal, so it cannot be read)" : a.Key));

    public static string ModuleDigest(AccessManifest manifest, string module, IEnumerable<AccessEntry> entries, bool creates, bool createActive)
        => AccessManifest.Hash(new JsonObject
        {
            ["generator"] = Generator, ["environment"] = manifest.Environment, ["module"] = module,
            ["createAccounts"] = creates, ["createActive"] = creates && createActive,
            ["entries"] = new JsonArray(entries.OrderBy(e => e.Role, StringComparer.OrdinalIgnoreCase).ThenBy(e => e.Username, StringComparer.OrdinalIgnoreCase)
                .Select(AccessManifest.EntryJson).ToArray()),
        }.ToJsonString());

    private static List<string> Checks(bool creates)
    {
        var names = new List<string> { ManifestEntity, StateEntity, AuditEntity, WriteAudit, Reconcile, TickPublish, TickDemand, TimerPublish, TimerDemand };
        if (creates) { names.Add(CreateUser); names.Add(RandomStructure); }
        return names;
    }

    private static JsonObject Job(AccessManifest manifest, AccessModuleFacts module, List<(AccessEntry Entry, AccessRoleFact Role)> rows,
        List<AccessRoleFact> roles, string digest, bool creates, bool createActive, bool needsUsers)
    {
        var ops = new JsonArray();
        var update = module.Marker != null;
        var has = (string name) => module.ReservedElements.ContainsKey(name);
        if (needsUsers) ops.Add(new JsonObject { ["op"] = "reference", ["producer"] = "Users", ["elements"] = new JsonArray("IServerAction:EncryptPassword") });

        var marker = new AccessMarker(manifest.ManifestVersion, digest);
        var records = rows.Select((r, i) => (Name: $"Entry{i + 1:000}", Order: i + 1, r.Entry, r.Role)).ToList();
        // IsDemo is the plan's derivation (the manifest flag must equal it, or the plan refuses): the row the run-time guard
        // re-checks against the allowlist in force.
        JsonObject Values((string Name, int Order, AccessEntry Entry, AccessRoleFact Role) r) => new()
        {
            ["Username"] = Literal(r.Entry.Username), ["RoleCode"] = Literal(r.Role.Name), ["IsGrant"] = r.Entry.Grant ? "True" : "False",
            ["ManifestVersion"] = manifest.ManifestVersion.ToString(), ["CreateIfMissing"] = r.Entry.CreateIfMissing && creates ? "True" : "False",
            [DemoAttribute] = module.IsDemo(r.Entry.Username) ? "True" : "False",
        };
        string Label((string Name, int Order, AccessEntry Entry, AccessRoleFact Role) r)
        {
            var text = $"{r.Order:000} {(r.Entry.Grant ? "grant" : "revoke")} {r.Role.Name}";
            return text.Length > 50 ? text[..50] : text;
        }

        var spec = new JsonObject();
        if (!update)
        {
            spec["static"] = new JsonArray(new JsonObject
            {
                ["name"] = ManifestEntity,
                ["description"] = ManifestDescription(marker),
                ["attributes"] = new JsonArray(
                    Attr("Username", "Text", "Username of the end user in (System) User; demo accounts only unless the manifest accepted others.", 250, true),
                    Attr("RoleCode", "Text", "Name of a persistent role of this module; only the roles in the ReconcileAccess switch are applied.", 50, true),
                    Attr("IsGrant", "Boolean", "True grants the role, False revokes it."),
                    Attr("ManifestVersion", "Integer", "Version of the access manifest that produced this row; AccessState refuses an older one."),
                    Attr("CreateIfMissing", "Boolean", "True creates the account (inactive, random password discarded) when it does not exist and account creation was opted in."),
                    Attr(DemoAttribute, "Boolean", DemoAttributeDescription)),
                ["records"] = new JsonArray(records.Select(r =>
                {
                    var o = Values(r); o["name"] = r.Name; o["label"] = Label(r); o["order"] = r.Order; return (JsonNode)o;
                }).ToArray()),
            });
            spec["entities"] = new JsonArray(
                new JsonObject
                {
                    ["name"] = StateEntity,
                    ["description"] = "Last access manifest version applied by ReconcileAccess in this environment; a published manifest older than it is refused.",
                    ["attributes"] = new JsonArray(
                        Attr("LastAppliedVersion", "Integer", "Highest manifest version applied."),
                        Attr("LastAppliedOn", "Date Time", "Server time of the last reconciliation."),
                        Attr("LastModuleDigest", "Text", "SHA-256 of the module part of the manifest last applied.", 64)),
                },
                new JsonObject
                {
                    ["name"] = AuditEntity,
                    ["description"] = "One row per reconciliation decision. Holds the user identifier only: no name, username or email.",
                    ["updateBehavior"] = "Optimized",
                    ["attributes"] = new JsonArray(
                        Attr("UserId", "User Identifier", "End user the decision applies to; null when the username was not found.", deleteRule: "Ignore"),
                        Attr("RoleCode", "Text", "Role of this module the decision applies to.", 50),
                        Attr("Action", "Text", "Grant, Revoke, Create or Reconcile.", 10),
                        Attr("Outcome", "Text", "Granted, Revoked, AlreadyGranted, AlreadyRevoked, UserNotFound, SkippedInactive, RoleNotAllowed, NotDemoListed, AccountCreated or DowngradeRefused.", 30),
                        Attr("ManifestVersion", "Integer", "Manifest version being applied."),
                        Attr("AuthorizationDigest", "Text", "SHA-256 of the canonical access manifest the user's words authorized (audit only, never checked by the server).", 64),
                        Attr("Trigger", "Text", "OnPublish (timer When Published) or OnDemand (timer run from Service Center).", 20),
                        Attr("AtUtc", "Date Time", "UTC time of the decision (database clock).")),
                });
        }
        if (creates && !has(RandomStructure))
            spec["structures"] = new JsonArray(new JsonObject
            {
                ["name"] = RandomStructure,
                ["description"] = "Holds the random text drawn by the database for a password that is hashed and discarded at once.",
                ["attributes"] = new JsonArray(new JsonObject { ["name"] = "Value", ["type"] = "Text", ["description"] = "Random text; never stored." }),
            });
        if (spec.Count > 0) ops.Add(new JsonObject { ["op"] = "spec", ["data"] = spec });

        if (update)
        {
            const string entity = "IStaticEntity:" + ManifestEntity;
            ops.Add(Set(entity, "Description", ManifestDescription(marker)));
            // a module generated before IsDemo existed (ssam-access-generator/1) gets the attribute before its rows are rewritten
            if (!(module.ManifestAttributes?.Contains(DemoAttribute, StringComparer.OrdinalIgnoreCase) ?? false))
            {
                const string alias = "$" + ManifestEntity + "." + DemoAttribute;
                ops.Add(new JsonObject { ["op"] = "create", ["parent"] = entity, ["type"] = "IEntityAttribute", ["name"] = DemoAttribute, ["as"] = alias });
                ops.Add(Set(alias, "DataType", "Boolean"));
                ops.Add(Set(alias, "Description", DemoAttributeDescription));
            }
            foreach (var r in records)
            {
                var target = entity + "/" + r.Name;
                if (!module.ManifestRecords.Contains(r.Name, StringComparer.OrdinalIgnoreCase))
                {
                    target = "$" + ManifestEntity + "." + r.Name;
                    ops.Add(new JsonObject { ["op"] = "create", ["parent"] = entity, ["type"] = "IRecord", ["name"] = r.Name, ["as"] = target });
                }
                ops.Add(Set(target + "/Label", "Value", Literal(Label(r))));
                ops.Add(Set(target + "/Order", "Value", r.Order.ToString()));
                foreach (var (attribute, value) in Values(r)) ops.Add(Set(target + "/" + attribute, "Value", value!.ToString()));
            }
            foreach (var stale in module.ManifestRecords.Where(n => !records.Any(r => string.Equals(r.Name, n, StringComparison.OrdinalIgnoreCase))).OrderBy(n => n, StringComparer.Ordinal))
                ops.Add(new JsonObject { ["op"] = "delete", ["target"] = entity + "/" + stale });
        }

        var actions = new JsonArray();
        JsonObject Action(JsonObject a) { if (has(a["name"]!.ToString())) a["replace"] = true; return a; }
        actions.Add(Action(WriteAuditAction(manifest)));
        if (creates) actions.Add(Action(CreateUserAction(createActive)));
        actions.Add(Action(ReconcileAction(roles, digest, creates, module.DemoAllowlists.Keys.OrderBy(k => k, StringComparer.Ordinal).ToList())));
        actions.Add(Action(TickAction(TickPublish, "OnPublish", $"Entry of the timer {TimerPublish} (When Published): applies the access manifest of this module after each publication.")));
        actions.Add(Action(TickAction(TickDemand, "OnDemand", $"Entry of the timer {TimerDemand}: applies the access manifest on demand, from Service Center > Factory > Modules > {module.Module} > Timers > {TimerDemand} > Run Now.")));
        // ReconcileAccess looks each manifest row's user up by username inside its loop (QUERY_IN_LOOP): the escape is explicit
        // and lands in the receipt; a join of the manifest with (System) User would remove it.
        ops.Add(new JsonObject { ["op"] = "logic", [QueryInLoopRule.AllowKey] = new JsonObject { ["why"] = "ReconcileAccess runs once per publication over the short access manifest; one user lookup per row by username" },
            ["data"] = new JsonObject { ["actions"] = actions } });
        if (!creates && has(CreateUser)) ops.Add(new JsonObject { ["op"] = "delete", ["target"] = "IServerAction:" + CreateUser });

        if (!has(TimerPublish)) AddTimer(ops, TimerPublish, TickPublish, "When Published",
            "Applies the access manifest of this module after each publication (ReconcileAccess; idempotent, audited in AccessAudit).");
        if (!has(TimerDemand)) AddTimer(ops, TimerDemand, TickDemand, null,
            "No schedule: run it from Service Center (Factory > Modules > " + module.Module + " > Timers > Run Now) to apply the access manifest on demand.");

        var entries = rows.Count;
        return new JsonObject
        {
            ["description"] = $"ssam access plan: manifestVersion {manifest.ManifestVersion} for {module.Module} ({entries} entries, roles {string.Join(", ", roles.Select(r => r.Name))}); "
                + $"{(update ? "updates" : "creates")} the private access reconciliation. Generated by {Generator}; do not edit by hand.",
            ["expectValid"] = true,
            ["expectedMessages"] = new JsonArray(),
            ["ops"] = ops,
        };
    }

    private static string ManifestDescription(AccessMarker marker)
        => "Access manifest rows of this module (generated by ssam access plan; change them only through a new manifest version). " + marker.Text;

    private const string DemoAttributeDescription = "True when the plan derived this account as a demo account (its username is in the demo sign-in allowlist of this module). "
        + "ReconcileAccess grants it a role, or creates it, only while the username is still in that allowlist in force (site property DemoLoginUsernames or OpsDemoLoginUsernames) at run time.";

    /// <summary>True when the username of the current row is an item of one of the module's demo sign-in allowlists, as the
    /// client's demo sign-in compares it: the list lower-cased, without spaces, wrapped in commas, so one Index finds only a
    /// whole item (usernames have no space or comma, AccessManifest.UsernameShape). Read from Site.*, i.e. the values in
    /// force in the environment, not the base the plan read. A module without such a property lists nobody.</summary>
    internal static string DemoListedExpression(IReadOnlyList<string> allowlistProperties) => allowlistProperties.Count == 0 ? "False"
        : string.Join(" or ", allowlistProperties.Select(p =>
            $"Index(\",\" + ToLower(Replace(Site.{p}, \" \", \"\")) + \",\", \",\" + ToLower(Trim({Cur}.Username)) + \",\") <> -1"));

    private static JsonObject WriteAuditAction(AccessManifest manifest) => new()
    {
        ["name"] = WriteAudit, ["kind"] = "server", ["public"] = false,
        ["description"] = "Appends one AccessAudit row with the database UTC clock. Records the user identifier only.",
        ["inputs"] = new JsonArray(
            Param("UserId", "User Identifier", "End user; NullIdentifier() when unknown."),
            Param("RoleCode", "Text", "Role of this module."),
            Param("Action", "Text", "Grant, Revoke, Create or Reconcile."),
            Param("Outcome", "Text", "Decision taken."),
            Param("ManifestVersion", "Integer", "Manifest version being applied."),
            Param("Trigger", "Text", "OnPublish or OnDemand.")),
        ["steps"] = new JsonArray(new JsonObject
        {
            ["get"] = AuditEntity, ["sql"] = true, ["as"] = "InsertAuditRow",
            ["statement"] = "SET NOCOUNT ON;\nINSERT INTO {" + AuditEntity + "} ([UserId], [RoleCode], [Action], [Outcome], [ManifestVersion], [AuthorizationDigest], [Trigger], [AtUtc])\n"
                + "VALUES (NULLIF(@UserId, 0), LEFT(@RoleCode, 50), LEFT(@Action, 10), LEFT(@Outcome, 30), @ManifestVersion, @AuthorizationDigest, LEFT(@Trigger, 20), CAST(SYSUTCDATETIME() AS datetime));\n"
                + "SELECT {" + AuditEntity + "}.* FROM {" + AuditEntity + "} WHERE {" + AuditEntity + "}.[Id] = SCOPE_IDENTITY()",
            ["params"] = new JsonObject
            {
                ["UserId"] = SqlParam("Integer", "IdentifierToInteger(UserId)"),
                ["RoleCode"] = SqlParam("Text", "RoleCode"),
                ["Action"] = SqlParam("Text", "Action"),
                ["Outcome"] = SqlParam("Text", "Outcome"),
                ["ManifestVersion"] = SqlParam("Integer", "ManifestVersion"),
                ["AuthorizationDigest"] = SqlParam("Text", Literal(manifest.Sha256)),
                ["Trigger"] = SqlParam("Text", "Trigger"),
            },
            ["max"] = 1,
        }),
    };

    /// <summary>Option D: the password is random text drawn by the database, hashed by Users.EncryptPassword and discarded
    /// inside this action. No literal password exists in the job or the module; the user sets the real one in the Users app.</summary>
    private static JsonObject CreateUserAction(bool createActive) => new()
    {
        ["name"] = CreateUser, ["kind"] = "server", ["public"] = false,
        ["description"] = "Creates a missing demo account " + (createActive ? "active" : "inactive") + " with a random password that nobody knows (drawn by the database, hashed and discarded here). "
            + "The user sets the real password" + (createActive ? "" : " and activates the account") + " in the Users application. Grants no role of the Users application.",
        ["inputs"] = new JsonArray(Param("Username", "Text", "Username of the account to create.")),
        ["outputs"] = new JsonArray(Param("UserId", "User Identifier", "Identifier of the created account.")),
        ["vars"] = new JsonArray(Param("NewUser", "User", "Account being created.")),
        ["steps"] = new JsonArray(
            new JsonObject
            {
                ["get"] = RandomStructure, ["sql"] = true, ["as"] = "DrawSecret",
                ["statement"] = "SELECT CONVERT(NVARCHAR(36), NEWID()) + CONVERT(NVARCHAR(36), NEWID()) AS [Value]", ["max"] = 1,
            },
            new JsonObject { ["call"] = "EncryptPassword", ["as"] = "HashSecret", ["args"] = new JsonObject { ["Username"] = "Username", ["Password"] = "DrawSecret.List.Current.List.Value" } },
            new JsonObject
            {
                ["assign"] = new JsonObject
                {
                    ["NewUser.Username"] = "Username", ["NewUser.Name"] = "Username", ["NewUser.Password"] = "HashSecret.EncryptedPassword",
                    ["NewUser.Is_Active"] = createActive ? "True" : "False", ["NewUser.Creation_Date"] = "CurrDateTime()",
                },
                ["as"] = "Prepare account",
            },
            new JsonObject { ["create"] = "User", ["record"] = "NewUser", ["as"] = "CreateAccount" },
            new JsonObject { ["assign"] = new JsonObject { ["UserId"] = "CreateAccount.Id" }, ["as"] = "Return account" }),
    };

    private static JsonObject ReconcileAction(List<AccessRoleFact> roles, string digest, bool creates, IReadOnlyList<string> allowlistProperties)
    {
        // the run-time demo guard: a demo row is granted (or its account created) only while it is listed in the environment
        var unlistedDemoGrant = $"{Cur}.IsGrant and {Cur}.{DemoAttribute} and not IsDemoListed";
        var cases = new JsonArray();
        foreach (var role in roles)
        {
            var check = "Check" + role.Name;
            cases.Add(new JsonObject
            {
                ["when"] = $"{Cur}.RoleCode = {Literal(role.Name)}",
                ["steps"] = new JsonArray(
                    new JsonObject { ["call"] = role.CheckAction, ["as"] = check, ["args"] = new JsonObject { ["UserId"] = "EntryUserId" } },
                    new JsonObject
                    {
                        ["if"] = Cur + ".IsGrant", ["as"] = "Grant " + role.Name + "?",
                        ["then"] = new JsonArray(new JsonObject
                        {
                            ["if"] = check + ".HasRole", ["as"] = "Has " + role.Name + " before grant?",
                            ["then"] = new JsonArray(Assign("Already granted " + role.Name, ("Outcome", Literal("AlreadyGranted")))),
                            ["else"] = new JsonArray(
                                new JsonObject { ["call"] = role.GrantAction, ["as"] = "Grant" + role.Name, ["args"] = new JsonObject { ["UserId"] = "EntryUserId" } },
                                Assign("Granted " + role.Name, ("Outcome", Literal("Granted")), ("Applied", "Applied + 1"))),
                        }),
                        ["else"] = new JsonArray(new JsonObject
                        {
                            ["if"] = check + ".HasRole", ["as"] = "Has " + role.Name + " before revoke?",
                            ["then"] = new JsonArray(
                                new JsonObject { ["call"] = role.RevokeAction, ["as"] = "Revoke" + role.Name, ["args"] = new JsonObject { ["UserId"] = "EntryUserId" } },
                                Assign("Revoked " + role.Name, ("Outcome", Literal("Revoked")), ("Applied", "Applied + 1"))),
                            ["else"] = new JsonArray(Assign("Already revoked " + role.Name, ("Outcome", Literal("AlreadyRevoked")))),
                        }),
                    }),
            });
        }

        var loop = new JsonArray(
            new JsonObject { ["get"] = "User", ["as"] = "FindUser", ["where"] = new JsonArray($"User.Username = {Cur}.Username"), ["max"] = "1" },
            Assign("Reset entry", ("EntryUserId", "NullIdentifier()"), ("IsEligible", "False"), ("Outcome", Literal("")),
                ("IsDemoListed", DemoListedExpression(allowlistProperties))),
            new JsonObject
            {
                ["if"] = "not FindUser.List.Empty", ["as"] = "User found?",
                ["then"] = new JsonArray(Assign("Use found user", ("EntryUserId", "FindUser.List.Current.User.Id"), ("IsEligible", "FindUser.List.Current.User.Is_Active"))),
            });
        if (creates)
            loop.Add(new JsonObject
            {
                // guard before CreateMissingUser: only a demo row whose username the allowlist in force still lists
                ["if"] = $"FindUser.List.Empty and {Cur}.CreateIfMissing and {Cur}.IsGrant and {Cur}.{DemoAttribute} and IsDemoListed", ["as"] = "Create listed demo account?",
                ["then"] = new JsonArray(
                    new JsonObject { ["call"] = CreateUser, ["as"] = "CreateAccount", ["args"] = new JsonObject { ["Username"] = Cur + ".Username" } },
                    Assign("Use created account", ("EntryUserId", "CreateAccount.UserId"), ("IsEligible", "True"), ("Applied", "Applied + 1")),
                    Audit("AuditAccountCreated", "EntryUserId", Literal("Create"), Literal("AccountCreated"))),
            });
        loop.Add(new JsonObject
        {
            ["if"] = "EntryUserId = NullIdentifier()", ["as"] = "Unknown user?",
            ["then"] = new JsonArray(Assign("User not found", ("Outcome", $"If({unlistedDemoGrant}, {Literal(NotDemoListed)}, {Literal("UserNotFound")})"))),
            ["else"] = new JsonArray(new JsonObject
            {
                ["if"] = "not IsEligible", ["as"] = "Inactive user?",
                ["then"] = new JsonArray(Assign("Skip inactive", ("Outcome", Literal("SkippedInactive")))),
                ["else"] = new JsonArray(new JsonObject
                {
                    // guard before any grant to a row marked demo; revokes always pass
                    ["if"] = unlistedDemoGrant, ["as"] = "Demo account not listed?",
                    ["then"] = new JsonArray(Assign("Refuse unlisted demo grant", ("Outcome", Literal(NotDemoListed)))),
                    ["else"] = new JsonArray(new JsonObject
                    {
                        ["switch"] = cases, ["as"] = "Allowed role",
                        ["otherwise"] = new JsonArray(Assign("Role not allowed", ("Outcome", Literal("RoleNotAllowed")))),
                    }),
                }),
            }),
        });
        loop.Add(Audit("AuditEntry", "EntryUserId", $"If({Cur}.IsGrant, {Literal("Grant")}, {Literal("Revoke")})", "Outcome"));

        return new JsonObject
        {
            ["name"] = Reconcile, ["kind"] = "server", ["public"] = false,
            ["description"] = "Applies the AccessManifest rows of this module: finds each user by username in (System) User, skips inactive accounts, "
                + "checks the role and grants or revokes only when needed, through a fixed allowlist of roles (" + string.Join(", ", roles.Select(r => r.Name)) + "). "
                + "A row marked IsDemo is granted only while its username is in the demo sign-in allowlist in force ("
                + (allowlistProperties.Count == 0 ? "none declared" : string.Join(", ", allowlistProperties.Select(p => "Site." + p))) + "); otherwise it is audited NotDemoListed. "
                + "Refuses a manifest older than AccessState (downgrade) and audits every decision in AccessAudit."
                + (creates ? " Creates a missing demo account through CreateMissingUser when a row asks for it and the allowlist in force lists it." : ""),
            ["inputs"] = new JsonArray(Param("Trigger", "Text", "OnPublish (timer When Published) or OnDemand (timer run from Service Center).")),
            ["outputs"] = new JsonArray(
                Param("Applied", "Integer", (creates ? "Grants, revokes and account creations" : "Grants and revokes") + " made by this run."),
                Param("IsRefused", "Boolean", "True when the published manifest is older than the last applied one.")),
            ["vars"] = new JsonArray(
                Param("ManifestVersion", "Integer", "Version of the published manifest rows."),
                Param("EntryUserId", "User Identifier", "User of the current row."),
                Param("IsEligible", "Boolean", "True when the user of the current row is active or was just created."),
                Param("IsDemoListed", "Boolean", "True when the username of the current row is an item of the module's demo sign-in allowlist in force (Site.*), compared as the demo sign-in compares it."),
                Param("Outcome", "Text", "Decision for the current row."),
                Param("State", StateEntity, "Last applied state.")),
            ["steps"] = new JsonArray(
                new JsonObject { ["get"] = ManifestEntity, ["as"] = "ReadManifest", ["sort"] = new JsonArray(ManifestEntity + ".Order", "Ascending") },
                new JsonObject { ["get"] = StateEntity, ["as"] = "ReadState", ["sort"] = new JsonArray(StateEntity + ".Id", "Descending"), ["max"] = "1" },
                Assign("Read version", ("ManifestVersion", $"If(ReadManifest.List.Empty, 0, {Cur}.ManifestVersion)"), ("Applied", "0"), ("IsRefused", "False")),
                new JsonObject
                {
                    ["if"] = $"not ReadState.List.Empty and ReadState.List.Current.{StateEntity}.LastAppliedVersion > ManifestVersion", ["as"] = "Downgrade?",
                    ["then"] = new JsonArray(
                        Assign("Refuse downgrade", ("IsRefused", "True")),
                        Audit("AuditDowngrade", "NullIdentifier()", Literal("Reconcile"), Literal("DowngradeRefused"), roleCode: Literal("")),
                        new JsonObject { ["return"] = true }),
                },
                new JsonObject { ["foreach"] = "ReadManifest.List", ["as"] = "EachEntry", ["do"] = loop },
                new JsonObject
                {
                    ["if"] = "not ReadState.List.Empty", ["as"] = "State exists?",
                    ["then"] = new JsonArray(Assign("Load state", ("State", $"ReadState.List.Current.{StateEntity}"))),
                },
                Assign("Record version", ("State.LastAppliedVersion", "ManifestVersion"), ("State.LastAppliedOn", "CurrDateTime()"), ("State.LastModuleDigest", Literal(digest))),
                new JsonObject { ["save"] = StateEntity, ["record"] = "State", ["as"] = "SaveState" }),
        };
    }

    private static JsonObject Audit(string name, string userId, string action, string outcome, string? roleCode = null) => new()
    {
        ["call"] = WriteAudit, ["as"] = name,
        ["args"] = new JsonObject
        {
            ["UserId"] = userId, ["RoleCode"] = roleCode ?? Cur + ".RoleCode", ["Action"] = action, ["Outcome"] = outcome,
            ["ManifestVersion"] = "ManifestVersion", ["Trigger"] = "Trigger",
        },
    };

    private static JsonObject TickAction(string name, string trigger, string description) => new()
    {
        ["name"] = name, ["kind"] = "server", ["public"] = false, ["description"] = description,
        ["steps"] = new JsonArray(new JsonObject { ["call"] = Reconcile, ["as"] = "Reconcile", ["args"] = new JsonObject { ["Trigger"] = Literal(trigger) } }),
    };

    private static void AddTimer(JsonArray ops, string name, string action, string? schedule, string description)
    {
        var alias = "$" + name;
        ops.Add(new JsonObject { ["op"] = "create", ["parent"] = "@espace", ["type"] = "ITimer", ["name"] = name, ["as"] = alias });
        ops.Add(Set(alias, "Action", "IServerAction:" + action));
        ops.Add(new JsonObject { ["op"] = "set", ["target"] = alias, ["prop"] = "TimeoutInMinutes", ["value"] = 5 });
        if (schedule != null) ops.Add(Set(alias, "Schedule", schedule));
        ops.Add(Set(alias, "Description", description));
    }

    private static JsonObject Assign(string label, params (string Variable, string Value)[] pairs)
    {
        var assign = new JsonObject();
        foreach (var (variable, value) in pairs) assign[variable] = value;
        return new JsonObject { ["assign"] = assign, ["as"] = label };
    }

    private static JsonObject Attr(string name, string type, string description, int? length = null, bool? mandatory = null, string? deleteRule = null)
    {
        var o = new JsonObject { ["name"] = name, ["type"] = type, ["description"] = description };
        if (length != null) o["length"] = length;
        if (mandatory != null) o["mandatory"] = mandatory;
        if (deleteRule != null) o["deleteRule"] = deleteRule;
        return o;
    }

    private static JsonObject Param(string name, string type, string description) => new() { ["name"] = name, ["type"] = type, ["description"] = description };
    private static JsonObject SqlParam(string type, string value) => new() { ["type"] = type, ["value"] = value };
    private static JsonObject Set(string target, string prop, string value) => new() { ["op"] = "set", ["target"] = target, ["prop"] = prop, ["value"] = value };

    /// <summary>OutSystems text literal. Callers pass only validated usernames, role names, digests and fixed words.</summary>
    internal static string Literal(string text) => "\"" + text.Replace("\"", "\"\"") + "\"";
}
