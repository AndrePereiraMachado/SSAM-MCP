using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Access;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// `ssam access` (O11 end-user roles, design 2.2 option A + opt-in D). The validation rules and the job generator are pure
/// functions of the manifest and the facts read from the bases, so most tests need no Studio; the last one proves the whole
/// plan (read, generate, check-job, apply, update, downgrade) over the blank-service fixture.
/// </summary>
public class AccessPlannerTests
{
    private const string Env = "personal-x.outsystemscloud.com";

    private static AccessManifest Manifest(string entries, int version = 1, string extra = "")
        => AccessManifest.Parse(JsonNode.Parse($$"""{"environment":"{{Env}}","manifestVersion":{{version}}{{extra}},"entries":[{{entries}}]}"""), Path.Combine(Path.GetTempPath(), "m.json"));

    /// <param name="allowlists">The demo sign-in allowlists read from the base; default: DemoLoginUsernames = Planner, DemoAdmin.</param>
    private static AccessModuleFacts Facts(string module = "App_CS", AccessMarker? marker = null, Dictionary<string, IReadOnlyList<string>?>? allowlists = null,
        bool user = true, bool encrypt = false, Dictionary<string, string>? reserved = null, IReadOnlyList<string>? records = null, params AccessRoleFact[] roles)
        => new(module, "C:\\bases\\" + module + ".oml", new string('a', 64), 1, roles.Length > 0 ? roles : [Role("Planner"), Role("DemoAdmin")],
            allowlists ?? new(StringComparer.OrdinalIgnoreCase) { ["DemoLoginUsernames"] = ["Planner", "DemoAdmin"] },
            user, encrypt, reserved ?? new(StringComparer.OrdinalIgnoreCase), marker, records ?? []);

    private static Dictionary<string, IReadOnlyList<string>?> Ops(params string[] names)
        => new(StringComparer.OrdinalIgnoreCase) { ["OpsDemoLoginUsernames"] = names };

    private static AccessRoleFact Role(string name, bool persistent = true) => new(name, persistent, $"Check{name}Role", $"Grant{name}Role", $"Revoke{name}Role");

    private static Dictionary<string, AccessModuleFacts> One(AccessModuleFacts facts) => new(StringComparer.OrdinalIgnoreCase) { [facts.Module] = facts };

    private const string PlannerGrant = """{"username":"Planner","demo":true,"role":"App_CS.Planner","action":"grant"}""";

    [Fact]
    public void Manifest_schema_is_closed_and_reports_every_error()
    {
        var ex = Assert.Throws<AccessManifestException>(() => AccessManifest.Parse(JsonNode.Parse("""
            {"environment":"https://x.example.com/","manifestVersion":0,"extra":1,"entries":[
              {"username":"a b","role":"Planner","action":"give","demo":"yes"},
              {"username":"Planner","role":"App_CS.Planner","action":"revoke","demo":true,"createIfMissing":true},
              {"username":"Planner","role":"App_CS.Planner","action":"grant","demo":true}]}
            """), "m.json"));
        var text = string.Join("\n", ex.Errors);
        foreach (var expected in new[] { "unknown key 'extra'", "bare host name", "manifestVersion is required", "username has characters",
                     "must be qualified as \"Module.Role\"", "action must be", "demo must be true or false", "createIfMissing applies only to grant",
                     "conflicting grant and revoke" })
            Assert.Contains(expected, text);
        Assert.DoesNotContain("\"Planner\"", text); // duplicates are named by username hash, never by the username
    }

    [Fact]
    public void Digest_covers_intent_only_order_and_base_paths_do_not_matter()
    {
        var a = Manifest(PlannerGrant + "," + """{"username":"DemoAdmin","demo":true,"role":"App_CS.DemoAdmin","action":"grant"}""");
        var b = AccessManifest.Parse(JsonNode.Parse($$"""
            {"environment":"{{Env.ToUpperInvariant()}}","manifestVersion":1,"bases":{"App_CS":"elsewhere/App_CS.oml"},"entries":[
              {"username":"DemoAdmin","demo":true,"role":"App_CS.DemoAdmin","action":"grant"},{{PlannerGrant}}]}
            """), Path.Combine(Path.GetTempPath(), "other", "m.json"));
        Assert.Equal(a.Sha256, b.Sha256);
        Assert.NotEqual(a.Sha256, Manifest(PlannerGrant, version: 2).Sha256);
        Assert.Equal(16, AccessManifest.UsernameHash(Env, "Planner").Length);
        Assert.Equal(AccessManifest.UsernameHash(Env, "planner"), AccessManifest.UsernameHash(Env.ToUpperInvariant(), "Planner"));
    }

    [Fact]
    public void Own_persistent_role_generates_one_private_job_per_owner_module()
    {
        var core = Facts("Core_CS", allowlists: Ops("AgentAdmin", "AgentAuditor"), roles: [Role("AgentAdmin")]);
        var app = Facts();
        var manifest = Manifest(PlannerGrant + "," + """{"username":"AgentAdmin","demo":true,"role":"Core_CS.AgentAdmin","action":"grant"}""");
        var plan = AccessPlanner.Plan(manifest, new Dictionary<string, AccessModuleFacts> { ["App_CS"] = app, ["Core_CS"] = core }, new());
        Assert.True(plan.Ok, string.Join("; ", plan.Errors));
        Assert.Equal(new[] { "App_CS", "Core_CS" }, plan.Modules.Select(m => m.Module));
        var job = plan.Modules[0].Job!;
        var check = JobPreflight.Analyze(job["ops"]!.AsArray());
        Assert.True(check["valid"]!.GetValue<bool>(), check["errors"]!.ToJsonString());
        Assert.Equal(0, check["publicActions"]!.GetValue<int>());
        var safety = AccessCommand.Safety(job);
        Assert.Equal(0, safety["userManagerMentions"]!.GetValue<int>());
        Assert.Equal(0, safety["passwordLiterals"]!.GetValue<int>());
        Assert.Equal(2, safety["timers"]!.GetValue<int>());
        var text = job.ToJsonString();
        Assert.Contains("\"Schedule\"", text);
        Assert.Contains("When Published", text);
        Assert.Contains("CheckPlannerRole", text); Assert.Contains("GrantPlannerRole", text); Assert.Contains("RevokePlannerRole", text);
        Assert.DoesNotContain("AgentAdmin", text);                 // the switch of App_CS only knows the roles this manifest names for App_CS
        Assert.DoesNotContain("DemoAdmin", text);
        Assert.DoesNotContain(AccessPlanner.CreateUser, text);     // account creation is opt-in
        var audit = job["ops"]![0]!["data"]!["entities"]!.AsArray().Single(e => e!["name"]!.ToString() == AccessPlanner.AuditEntity)!;
        Assert.Equal(new[] { "UserId", "RoleCode", "Action", "Outcome", "ManifestVersion", "AuthorizationDigest", "Trigger", "AtUtc" },
            audit["attributes"]!.AsArray().Select(a => a!["name"]!.ToString()));
        Assert.Contains(manifest.Sha256, text);                    // AuthorizationDigest links the audit to the receipts
        Assert.Equal(job.ToJsonString(), AccessPlanner.Plan(manifest, new Dictionary<string, AccessModuleFacts> { ["App_CS"] = app, ["Core_CS"] = core }, new()).Modules[0].Job!.ToJsonString());
    }

    [Theory]
    [InlineData("""{"username":"Planner","demo":true,"role":"App_CS.Missing","action":"grant"}""", "is not a role defined in App_CS")]
    [InlineData("""{"username":"Planner","demo":true,"role":"App_CS.Session","action":"grant"}""", "is not persistent")]
    [InlineData("""{"username":"Planner","demo":true,"role":"App_CS.UserManager","action":"grant"}""", "never granted or revoked")]
    [InlineData("""{"username":"Planner","demo":true,"role":"Users.UserManager","action":"grant"}""", "never managed by ssam access")]
    [InlineData("""{"username":"Planner","demo":true,"role":"Other_CS.Planner","action":"grant"}""", "no base for module Other_CS")]
    [InlineData("""{"username":"Planner","demo":false,"role":"App_CS.Planner","action":"grant"}""", "listed in the demo sign-in allowlist of App_CS")]
    [InlineData("""{"username":"someone","demo":true,"role":"App_CS.Planner","action":"grant"}""", "demo is derived from the owner module")]
    [InlineData("""{"username":"someone","demo":false,"role":"App_CS.Planner","action":"grant"}""", "non-demo account refused")]
    [InlineData("""{"username":"Planner","demo":true,"role":"App_CS.Planner","action":"grant","createIfMissing":true}""", "--create-accounts")]
    public void Allowlist_and_demo_rules_refuse(string entry, string expected)
    {
        var facts = Facts(roles: [Role("Planner"), Role("Session", persistent: false), Role("UserManager")]);
        var plan = AccessPlanner.Plan(Manifest(entry), One(facts), new());
        Assert.False(plan.Ok);
        Assert.Contains(plan.Errors, e => e.Contains(expected));
        Assert.Empty(plan.Modules);
        Assert.DoesNotContain(plan.Errors, e => e.Contains("someone"));
    }

    [Fact]
    public void Role_of_another_base_names_its_owner()
    {
        var longName = new string('R', 51);
        Assert.Contains(AccessPlanner.Plan(Manifest($$"""{"username":"Planner","demo":true,"role":"App_CS.{{longName}}","action":"grant"}"""),
            One(Facts(roles: [Role(longName)])), new()).Errors, e => e.Contains("longer than the 50 characters"));
        var facts = new Dictionary<string, AccessModuleFacts> { ["App_CS"] = Facts(), ["Core_CS"] = Facts("Core_CS", roles: [Role("AgentAdmin")]) };
        var plan = AccessPlanner.Plan(Manifest("""{"username":"AgentAdmin","demo":true,"role":"App_CS.AgentAdmin","action":"grant"}"""), facts, new());
        Assert.Contains(plan.Errors, e => e.Contains("the owner module is Core_CS"));
    }

    [Fact]
    public void Demo_warnings_and_explicit_non_demo_acceptance()
    {
        var plan = AccessPlanner.Plan(Manifest("""{"username":"DemoAdmin","demo":true,"role":"App_CS.DemoAdmin","action":"grant"}"""), One(Facts()), new());
        Assert.True(plan.Ok);
        Assert.Contains(plan.Warnings, w => w.Contains("administrative role granted to a demo account"));
        Assert.Contains(plan.Warnings, w => w.Contains("IsDemoLoginEnabled"));

        var accepted = AccessPlanner.Plan(Manifest("""{"username":"someone","demo":false,"role":"App_CS.Planner","action":"grant"}""", extra: ",\"allowNonDemoAccounts\":true"), One(Facts()), new());
        Assert.True(accepted.Ok, string.Join("; ", accepted.Errors));
        Assert.Contains(accepted.Warnings, w => w.Contains("stored in the published modules"));

        var unknownDemo = AccessPlanner.Plan(Manifest("""{"username":"Guest","demo":true,"role":"App_CS.Planner","action":"grant"}"""), One(Facts()), new());
        Assert.False(unknownDemo.Ok);                             // was a warning before the K2 review: now a refusal
        Assert.Contains(unknownDemo.Errors, e => e.Contains("not in DemoLoginUsernames of App_CS"));
    }

    /// <summary>K2 review major 2: the manifest's demo flag is never trusted. Demo means "in a DemoLoginUsernames /
    /// OpsDemoLoginUsernames default of the owner module, read from its OML"; any mismatch is refused, allowNonDemoAccounts
    /// cannot launder a self-declared demo account, and account creation is limited to that list.</summary>
    [Fact]
    public void Demo_is_derived_from_the_owner_module_allowlists_never_from_the_manifest()
    {
        var accept = ",\"allowNonDemoAccounts\":true";
        // a username outside the list, self-declared demo, asking for an admin role: refused even with allowNonDemoAccounts
        foreach (var extra in new[] { "", accept })
        {
            var spoof = AccessPlanner.Plan(Manifest("""{"username":"real.person","demo":true,"role":"App_CS.DemoAdmin","action":"grant"}""", extra: extra), One(Facts()), new());
            Assert.False(spoof.Ok);
            Assert.Contains(spoof.Errors, e => e.Contains("demo is derived from the owner module"));
            Assert.Empty(spoof.Modules);
        }
        // account creation: only usernames of the allowlist, whatever the manifest says
        var create = """{"username":"real.person","demo":false,"role":"App_CS.Planner","action":"grant","createIfMissing":true}""";
        var created = AccessPlanner.Plan(Manifest(create, extra: accept), One(Facts(encrypt: true)), new(CreateAccounts: true));
        Assert.Contains(created.Errors, e => e.Contains("account creation is limited to the usernames of the demo sign-in allowlist of App_CS"));
        var listed = AccessPlanner.Plan(Manifest("""{"username":"planner","demo":true,"role":"App_CS.Planner","action":"grant","createIfMissing":true}"""),
            One(Facts(encrypt: true)), new(CreateAccounts: true));
        Assert.True(listed.Ok, string.Join("; ", listed.Errors));   // trimmed, case-insensitive, like the demo sign-in

        // the list of the OWNER module decides: an HMISJHA-style list does not make an account demo for a Core role
        var facts = new Dictionary<string, AccessModuleFacts>(StringComparer.OrdinalIgnoreCase)
        {
            ["App_CS"] = Facts(), ["Core_CS"] = Facts("Core_CS", allowlists: Ops("AgentAdmin"), roles: [Role("AgentAuditor")]),
        };
        var crossed = AccessPlanner.Plan(Manifest("""{"username":"Planner","demo":true,"role":"Core_CS.AgentAuditor","action":"grant"}"""), facts, new());
        Assert.Contains(crossed.Errors, e => e.Contains("not in OpsDemoLoginUsernames of Core_CS") && e.Contains("in the allowlist of App_CS, which does not own AgentAuditor"));
        var ops = AccessPlanner.Plan(Manifest("""{"username":"AgentAdmin","demo":true,"role":"Core_CS.AgentAuditor","action":"grant"}"""), facts, new());
        Assert.True(ops.Ok, string.Join("; ", ops.Errors));

        // no allowlist, or one that cannot be read offline: nobody is demo there
        var none = AccessPlanner.Plan(Manifest(PlannerGrant), One(Facts(allowlists: new(StringComparer.OrdinalIgnoreCase))), new());
        Assert.Contains(none.Errors, e => e.Contains("declares neither DemoLoginUsernames nor OpsDemoLoginUsernames"));
        var unreadable = AccessPlanner.Plan(Manifest(PlannerGrant), One(Facts(allowlists: new(StringComparer.OrdinalIgnoreCase) { ["DemoLoginUsernames"] = null })), new());
        Assert.Contains(unreadable.Errors, e => e.Contains("cannot be read"));

        Assert.Equal(new[] { "Planner", "SmeReviewer" }, AccessBaseReader.ParseAllowlist("\" Planner , SmeReviewer,\""));
        Assert.Empty(AccessBaseReader.ParseAllowlist("")!);
        Assert.Null(AccessBaseReader.ParseAllowlist("\"Planner\" + Site.Other"));
        Assert.Null(AccessBaseReader.ParseAllowlist("\"a\" + \"b\""));
        Assert.Null(AccessBaseReader.ParseAllowlist("GetUsernames()"));
    }

    /// <summary>The same derivation on the real bases of the PoC (tests/fixtures/hmisjha, byte-identical to the offline proof's
    /// bases): the Core declares only OpsDemoLoginUsernames, HMISJHA_CS only DemoLoginUsernames, each read by its exact name;
    /// the six demo accounts pass, a self-declared demo account and an account of the other module's list are refused.</summary>
    [Fact]
    public void Real_bases_give_the_demo_allowlists_the_plan_derives_from()
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(AccessPlannerTests).Assembly.Location)!)!;
        var host = new ModelHost(Path.Combine(root, ".local", "access-tests", Guid.NewGuid().ToString("N"), "model"));
        var core = AccessBaseReader.Read(host, Path.Combine(root, "tests", "fixtures", "hmisjha", "AgentOps_Core_CS-v5585.oml"));
        var jha = AccessBaseReader.Read(host, Path.Combine(root, "tests", "fixtures", "hmisjha", "HMISJHA_CS-v5578.oml"));
        Assert.Equal(new[] { "OpsDemoLoginUsernames" }, core.DemoAllowlists.Keys);
        Assert.Equal(new[] { "AgentAdmin", "AgentAuditor" }, core.DemoAllowlists["OpsDemoLoginUsernames"]);
        Assert.Equal(new[] { "DemoLoginUsernames" }, jha.DemoAllowlists.Keys);
        Assert.Equal(6, jha.DemoAllowlists["DemoLoginUsernames"]!.Count);

        var facts = new Dictionary<string, AccessModuleFacts>(StringComparer.OrdinalIgnoreCase) { [core.Module] = core, [jha.Module] = jha };
        var six = AccessManifest.Read(Path.Combine(root, "tests", "access", "hmisjha-demo-roles.json"));
        var plan = AccessPlanner.Plan(six, facts, new());
        Assert.True(plan.Ok, string.Join("; ", plan.Errors));
        Assert.Equal(new[] { "AgentOps_Core_CS", "HMISJHA_CS" }, plan.Modules.Select(m => m.Module));
        // the run-time guard of each module reads its own allowlist in force, and only that one
        var coreJob = plan.Modules[0].Job!.ToJsonString(); var jhaJob = plan.Modules[1].Job!.ToJsonString();
        Assert.Contains("Site.OpsDemoLoginUsernames", coreJob); Assert.DoesNotContain("Site.DemoLoginUsernames", coreJob);
        Assert.Contains("Site.DemoLoginUsernames", jhaJob); Assert.DoesNotContain("Site.OpsDemoLoginUsernames", jhaJob);

        AccessManifest One(string entry, string extra = "") => AccessManifest.Parse(JsonNode.Parse(
            $$"""{"environment":"personal-2qqw9srv.outsystemscloud.com","manifestVersion":1{{extra}},"entries":[{{entry}}]}"""), Path.Combine(root, "m.json"));
        Assert.Contains(AccessPlanner.Plan(One("""{"username":"real.person","demo":true,"role":"HMISJHA_CS.DemoAdmin","action":"grant"}""", ",\"allowNonDemoAccounts\":true"), facts, new()).Errors,
            e => e.Contains("not in DemoLoginUsernames of HMISJHA_CS"));
        Assert.Contains(AccessPlanner.Plan(One("""{"username":"Planner","demo":true,"role":"AgentOps_Core_CS.AgentAuditor","action":"grant"}"""), facts, new()).Errors,
            e => e.Contains("not in OpsDemoLoginUsernames of AgentOps_Core_CS") && e.Contains("allowlist of HMISJHA_CS"));
    }

    /// <summary>K2 review major 1 (CLI side): the arguments are parsed strictly, so the words are always the value of --words and
    /// can never set --execute; the MCP argv (--prepare-only ... --words &lt;words&gt;) always parses to prepare.</summary>
    [Fact]
    public void Words_can_never_switch_apply_to_execution()
    {
        foreach (var words in new[] { "--execute", "ok --execute", "--create-accounts", "--prepare-only --execute", "--ss-dir" })
        {
            var mcp = AccessArguments.Parse(["apply", "--prepare-only", "--manifest", "C:\\m.json", "--words", words]);
            Assert.False(mcp.Execute, words);
            Assert.True(mcp.PrepareOnly);
            Assert.Equal(words, mcp.Words);
            Assert.False(AccessArguments.Parse(["apply", "--manifest", "C:\\m.json", "--words", words]).Execute, words);
        }
        Assert.True(AccessArguments.Parse(["apply", "--manifest", "C:\\m.json", "--words", "ok", "--execute"]).Execute);   // the explicit flag
        Assert.True(AccessArguments.Parse(["apply", "--execute", "--manifest", "C:\\m.json", "--words", "ok"]).Execute);
        foreach (var refused in new string[][]
                 {
                     ["apply", "--prepare-only", "--execute", "--manifest", "C:\\m.json", "--words", "ok"],        // both modes
                     ["apply", "--prepare-only", "--manifest", "C:\\m.json", "--words", "ok", "--execute"],
                     ["apply", "--manifest", "C:\\m.json", "--words", "a", "--words", "b"],                         // repeated option
                     ["apply", "--manifest", "C:\\m.json", "--words", "ok", "--create-accounts"],                  // not an apply option
                     ["apply", "--manifest", "C:\\m.json", "--words", "ok", "stray"],                              // stray token
                     ["apply", "--manifest", "--execute", "--words", "ok"],                                        // value missing
                     ["apply", "--manifest", "C:\\m.json", "--words"],
                     ["plan", "--manifest", "C:\\m.json", "--words", "ok"],                                        // plan takes no words
                     ["plan", "--manifest", "C:\\m.json", "--create-active"],
                     ["deliver"],
                 })
            Assert.Throws<ArgumentException>(() => AccessArguments.Parse(refused));
        var plan = AccessArguments.Parse(["plan", "--manifest", "C:\\m.json", "--module-base", "App_CS=C:\\a.oml", "--producer", "Users=C:\\u.oml", "--create-accounts"]);
        Assert.Equal("C:\\a.oml", plan.ModuleBases["App_CS"]);
        Assert.Equal(new[] { "Users=C:\\u.oml" }, plan.Producers);
        Assert.True(plan.CreateAccounts);
        Assert.Equal("verify", AccessArguments.Parse(["verify"]).Action);
    }

    [Fact]
    public void Manifest_version_is_monotonic_against_the_base_and_the_ledger()
    {
        var manifest = Manifest(PlannerGrant, version: 2);
        var digest = AccessPlanner.ModuleDigest(manifest, "App_CS", manifest.Entries, false, false);
        var ours = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { [AccessPlanner.ManifestEntity] = "StaticEntity", [AccessPlanner.Reconcile] = "ServerAction" };

        Assert.Contains(AccessPlanner.Plan(manifest, One(Facts(marker: new(3, digest), reserved: ours)), new()).Errors, e => e.Contains("downgrade refused"));
        Assert.Contains(AccessPlanner.Plan(manifest, One(Facts(marker: new(2, new string('b', 64)), reserved: ours)), new()).Errors, e => e.Contains("raise manifestVersion"));
        var same = AccessPlanner.Plan(manifest, One(Facts(marker: new(1, digest), reserved: ours)), new());
        Assert.Equal("unchanged", same.Modules.Single().Status);              // same module content under a newer version: no delivery
        Assert.Null(same.Modules.Single().Job);

        var ledger = new Dictionary<string, AccessLedgerEntry>(StringComparer.OrdinalIgnoreCase) { ["App_CS"] = new(5, new string('c', 64), "op5") };
        Assert.Contains(AccessPlanner.Plan(manifest, One(Facts()), new(), ledger).Errors, e => e.Contains("operation op5 already delivered manifestVersion 5"));
        var stale = new Dictionary<string, AccessLedgerEntry>(StringComparer.OrdinalIgnoreCase) { ["App_CS"] = new(1, new string('c', 64), "op1") };
        Assert.Contains(AccessPlanner.Plan(manifest, One(Facts()), new(), stale).Errors, e => e.Contains("base is older than the last delivery"));
    }

    [Fact]
    public void Update_mode_rewrites_records_replaces_logic_and_deletes_surplus_rows()
    {
        var manifest = Manifest(PlannerGrant, version: 2);
        var ours = AccessPlanner.ReservedNames.Where(n => n is not (AccessPlanner.CreateUser or AccessPlanner.RandomStructure))
            .ToDictionary(n => n, n => "x", StringComparer.OrdinalIgnoreCase);
        string[] current = ["Id", "Label", "Order", "Username", "RoleCode", "IsGrant", "ManifestVersion", "CreateIfMissing", AccessPlanner.DemoAttribute];
        var plan = AccessPlanner.Plan(manifest, One(Facts(marker: new(1, new string('b', 64)), reserved: ours, records: ["Entry001", "Entry002"]) with { ManifestAttributes = current }), new());
        Assert.True(plan.Ok, string.Join("; ", plan.Errors));
        var ops = plan.Modules.Single().Job!["ops"]!.AsArray().OfType<JsonObject>().ToList();
        Assert.DoesNotContain(ops, o => o["op"]!.ToString() == "spec");
        Assert.Contains(ops, o => o["op"]!.ToString() == "set" && o["target"]!.ToString() == "IStaticEntity:AccessManifest/Entry001/ManifestVersion" && o["value"]!.ToString() == "2");
        Assert.Contains(ops, o => o["op"]!.ToString() == "set" && o["target"]!.ToString() == "IStaticEntity:AccessManifest/Entry001/IsDemo" && o["value"]!.ToString() == "True");
        Assert.Contains(ops, o => o["op"]!.ToString() == "delete" && o["target"]!.ToString() == "IStaticEntity:AccessManifest/Entry002");
        Assert.DoesNotContain(ops, o => o["type"]?.ToString() == "ITimer");
        Assert.DoesNotContain(ops, o => o["type"]?.ToString() == "IEntityAttribute");       // IsDemo is already there
        var actions = ops.Single(o => o["op"]!.ToString() == "logic")["data"]!["actions"]!.AsArray();
        Assert.All(actions, a => Assert.True(a!["replace"]?.GetValue<bool>()));

        // a module generated before IsDemo (ssam-access-generator/1): the attribute is added before the rows are rewritten
        var old = AccessPlanner.Plan(manifest, One(Facts(marker: new(1, new string('b', 64)), reserved: ours, records: ["Entry001"])
            with { ManifestAttributes = current.Where(a => a != AccessPlanner.DemoAttribute).ToList() }), new());
        var oldOps = old.Modules.Single().Job!["ops"]!.AsArray().OfType<JsonObject>().ToList();
        var add = oldOps.FindIndex(o => o["type"]?.ToString() == "IEntityAttribute" && o["name"]!.ToString() == AccessPlanner.DemoAttribute);
        Assert.True(add >= 0);
        Assert.True(add < oldOps.FindIndex(o => o["target"]?.ToString() == "IStaticEntity:AccessManifest/Entry001/IsDemo"));
        Assert.Contains(oldOps, o => o["target"]?.ToString() == "$AccessManifest.IsDemo" && o["prop"]?.ToString() == "DataType" && o["value"]!.ToString() == "Boolean");
    }

    /// <summary>K2 review minor 2 (B6 follow-up): the plan derives "demo" from a base file, so the generated logic re-checks
    /// the allowlist in force (Site.*) before CreateMissingUser and before any grant to a row marked demo; revokes pass.</summary>
    [Fact]
    public void Generated_logic_rechecks_the_demo_allowlist_in_force_before_create_and_demo_grants()
    {
        var entry = """{"username":"Planner","demo":true,"role":"App_CS.Planner","action":"grant","createIfMissing":true}""";
        var facts = Facts(encrypt: true, allowlists: new(StringComparer.OrdinalIgnoreCase) { ["DemoLoginUsernames"] = ["Planner"], ["OpsDemoLoginUsernames"] = ["ops.demo"] });
        var plan = AccessPlanner.Plan(Manifest(entry), One(facts), new(CreateAccounts: true));
        Assert.True(plan.Ok, string.Join("; ", plan.Errors));
        var job = plan.Modules.Single().Job!;
        var spec = job["ops"]!.AsArray().OfType<JsonObject>().Single(o => o["op"]!.ToString() == "spec")["data"]!;
        var manifestEntity = spec["static"]![0]!;
        Assert.Contains(manifestEntity["attributes"]!.AsArray(), a => a!["name"]!.ToString() == AccessPlanner.DemoAttribute && a["type"]!.ToString() == "Boolean");
        Assert.Equal("True", manifestEntity["records"]![0]![AccessPlanner.DemoAttribute]!.ToString());

        var reconcile = job["ops"]!.AsArray().OfType<JsonObject>().Single(o => o["op"]!.ToString() == "logic")["data"]!["actions"]!.AsArray()
            .Single(a => a!["name"]!.ToString() == AccessPlanner.Reconcile)!;
        var text = reconcile.ToJsonString();
        const string cur = "ReadManifest.List.Current.AccessManifest";
        // the allowlists in force, normalized as the demo sign-in normalizes them, both properties of the module
        var listed = AccessPlanner.DemoListedExpression(["DemoLoginUsernames", "OpsDemoLoginUsernames"]);
        Assert.Equal($"Index(\",\" + ToLower(Replace(Site.DemoLoginUsernames, \" \", \"\")) + \",\", \",\" + ToLower(Trim({cur}.Username)) + \",\") <> -1"
            + $" or Index(\",\" + ToLower(Replace(Site.OpsDemoLoginUsernames, \" \", \"\")) + \",\", \",\" + ToLower(Trim({cur}.Username)) + \",\") <> -1", listed);
        var loop = reconcile["steps"]!.AsArray().OfType<JsonObject>().Single(s => s["foreach"] != null)["do"]!.AsArray().OfType<JsonObject>().ToList();
        Assert.Equal(listed, loop.Single(s => s["as"]?.ToString() == "Reset entry")["assign"]!["IsDemoListed"]!.ToString());
        // guard before CreateMissingUser
        var create = loop.Single(s => s["as"]?.ToString() == "Create listed demo account?");
        Assert.Equal($"FindUser.List.Empty and {cur}.CreateIfMissing and {cur}.IsGrant and {cur}.IsDemo and IsDemoListed", create["if"]!.ToString());
        Assert.Equal(AccessPlanner.CreateUser, create["then"]![0]!["call"]!.ToString());
        Assert.True(loop.FindIndex(s => s["as"]?.ToString() == "Reset entry") < loop.IndexOf(create));
        // guard before any grant to a row marked demo: the Switch (and every Grant call) sits in its else branch
        var unknown = loop.Single(s => s["as"]?.ToString() == "Unknown user?");
        Assert.Contains("\"NotDemoListed\"", unknown["then"]![0]!["assign"]!["Outcome"]!.ToString());
        var guard = unknown["else"]![0]!["else"]![0]!;
        Assert.Equal($"{cur}.IsGrant and {cur}.IsDemo and not IsDemoListed", guard["if"]!.ToString());
        Assert.Equal("\"NotDemoListed\"", guard["then"]![0]!["assign"]!["Outcome"]!.ToString());
        Assert.Contains("GrantPlannerRole", guard["else"]!.ToJsonString());
        Assert.DoesNotContain("GrantPlannerRole", guard["then"]!.ToJsonString());
        Assert.Contains(reconcile["vars"]!.AsArray(), v => v!["name"]!.ToString() == "IsDemoListed");
        Assert.True(JobPreflight.Analyze(job["ops"]!.AsArray())["valid"]!.GetValue<bool>());

        // a module that declares no allowlist lists nobody at run time (and the plan admits no demo row there)
        Assert.Equal("False", AccessPlanner.DemoListedExpression([]));
        // the module's own spelling of the property is what Site.<name> reads
        var spelled = AccessPlanner.Plan(Manifest(PlannerGrant), One(Facts(allowlists: new(StringComparer.OrdinalIgnoreCase) { ["demoLoginUsernames"] = ["Planner"] })), new());
        Assert.Contains("Site.demoLoginUsernames", spelled.Modules.Single().Job!.ToJsonString());
    }

    [Fact]
    public void Allowlist_digest_is_normalized_and_names_nobody()
    {
        var a = AccessBaseReader.AllowlistSha256(["Planner", " SmeReviewer", "planner", ""]);
        Assert.Equal(a, AccessBaseReader.AllowlistSha256(["smereviewer", "PLANNER"]));
        Assert.Equal(AccessManifest.Hash("planner\nsmereviewer"), a);
        Assert.NotEqual(a, AccessBaseReader.AllowlistSha256(["planner"]));
    }

    [Fact]
    public void Foreign_elements_with_reserved_names_and_missing_user_reference_refuse()
    {
        var foreign = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { [AccessPlanner.AuditEntity] = "ServerEntity" };
        Assert.Contains(AccessPlanner.Plan(Manifest(PlannerGrant), One(Facts(reserved: foreign)), new()).Errors, e => e.Contains("not generated by it"));
        Assert.Contains(AccessPlanner.Plan(Manifest(PlannerGrant), One(Facts(user: false)), new()).Errors, e => e.Contains("does not reference (System) User"));
    }

    [Fact]
    public void Account_creation_is_opt_in_needs_users_and_never_carries_a_password()
    {
        var entry = """{"username":"Planner","demo":true,"role":"App_CS.Planner","action":"grant","createIfMissing":true}""";
        Assert.Contains(AccessPlanner.Plan(Manifest(entry), One(Facts()), new(CreateAccounts: true)).Errors, e => e.Contains("--producer Users="));
        var plan = AccessPlanner.Plan(Manifest(entry), One(Facts()), new(CreateAccounts: true, HasUsersProducer: true));
        Assert.True(plan.Ok, string.Join("; ", plan.Errors));
        var module = plan.Modules.Single();
        Assert.True(module.NeedsUsersProducer);
        Assert.Equal(1, module.Creates);
        var ops = module.Job!["ops"]!.AsArray();
        Assert.Equal("reference", ops[0]!["op"]!.ToString());
        Assert.Equal(new[] { "IServerAction:EncryptPassword" }, ops[0]!["elements"]!.AsArray().Select(e => e!.ToString()));
        var create = ops.OfType<JsonObject>().Single(o => o["op"]!.ToString() == "logic")["data"]!["actions"]!.AsArray()
            .Single(a => a!["name"]!.ToString() == AccessPlanner.CreateUser)!;
        Assert.False(create["public"]!.GetValue<bool>());
        var text = create.ToJsonString();
        Assert.Contains("NEWID()", text);
        Assert.Contains("\"NewUser.Is_Active\":\"False\"", text);  // inactive by default
        Assert.Contains("\"NewUser.Password\":\"HashSecret.EncryptedPassword\"", text);
        var safety = AccessCommand.Safety(module.Job!);
        Assert.Equal(0, safety["passwordLiterals"]!.GetValue<int>());
        Assert.Equal(0, safety["userManagerMentions"]!.GetValue<int>());
        Assert.True(JobPreflight.Analyze(ops)["valid"]!.GetValue<bool>());

        var already = AccessPlanner.Plan(Manifest(entry), One(Facts(encrypt: true)), new(CreateAccounts: true));
        Assert.True(already.Ok); Assert.False(already.Modules.Single().NeedsUsersProducer);
        var active = AccessPlanner.Plan(Manifest(entry), One(Facts(encrypt: true)), new(CreateAccounts: true, CreateActive: true));
        Assert.Contains("\"NewUser.Is_Active\":\"True\"", active.Modules.Single().Job!.ToJsonString());
    }

    /// <summary>A plan.json as `access plan` writes it, for one module App_CS with a trivial job; returns the manifest path.</summary>
    private static string FabricatedPlan(string work)
    {
        var manifestPath = Path.Combine(work, "m.json");
        File.WriteAllText(manifestPath, $$"""{"environment":"{{Env}}","manifestVersion":1,"entries":[{{PlannerGrant}}]}""");
        var manifest = AccessManifest.Read(manifestPath);
        var folder = Path.Combine(work, "plans", $"v1-{manifest.Sha256[..12]}"); Directory.CreateDirectory(folder);
        var job = Path.Combine(folder, "App_CS-access.json"); File.WriteAllText(job, "{\"ops\":[]}");
        File.WriteAllText(Path.Combine(folder, "plan.json"), new JsonObject
        {
            ["schema"] = AccessCommand.PlanSchema, ["ok"] = true, ["manifest"] = new JsonObject { ["sha256"] = manifest.Sha256 },
            ["modules"] = new JsonArray(new JsonObject
            {
                ["module"] = "App_CS", ["status"] = "changes", ["mode"] = "create", ["moduleDigest"] = new string('d', 64),
                ["base"] = new JsonObject { ["version"] = 7, ["sha256"] = new string('a', 64) },
                ["counts"] = new JsonObject { ["grants"] = 1, ["revokes"] = 0, ["creates"] = 0 },
                ["checks"] = new JsonArray("ReconcileAccess"),
                ["job"] = new JsonObject { ["path"] = job, ["sha256"] = DeliveryReceipt.Hash(job) },
            }),
            ["users"] = new JsonArray(new JsonObject { ["hash"] = AccessManifest.UsernameHash(Env, "Planner") }),
        }.ToJsonString());
        return manifestPath;
    }

    [Fact]
    public void Apply_needs_words_records_only_hashes_and_never_replays_an_operation()
    {
        var work = Path.Combine(Path.GetTempPath(), "ssam-access-apply-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        try
        {
            var manifestPath = FabricatedPlan(work);
            var job = Directory.GetFiles(Path.Combine(work, "plans"), "App_CS-access.json", SearchOption.AllDirectories).Single();
            AccessCommand.ApplyRequest Request(string? words, bool execute, string? id = null)
                => new(manifestPath, work, words, null, id, execute, Path.Combine(work, "deliver-work"), 4516, "dotnet anvil.dll");

            Assert.Equal("words", AccessCommand.Apply(Request(null, false), null)["stage"]!.ToString());
            var prepared = AccessCommand.Apply(Request("  yes, grant the demo roles  ", false), null);
            Assert.True(prepared["ok"]!.GetValue<bool>(), prepared.ToJsonString());
            Assert.Equal("prepared", prepared["status"]!.ToString());
            Assert.Equal("prepare", prepared["mode"]!.ToString());
            Assert.Contains("not performed", prepared["execution"]!.ToString());
            Assert.Equal(AccessManifest.Hash("yes, grant the demo roles"), prepared["wordsSha256"]!.ToString());
            var receiptText = File.ReadAllText(prepared["receiptPath"]!.ToString()) + File.ReadAllText(prepared["receiptReadable"]!.ToString());
            Assert.Contains(AccessManifest.UsernameHash(Env, "Planner"), receiptText);
            Assert.DoesNotContain("grant the demo roles", receiptText);
            Assert.DoesNotContain("\"Planner\"", receiptText);
            Assert.Contains("deliver --module App_CS", prepared["deliveries"]![0]!["command"]!.ToString());
            Assert.Equal(Env, prepared["deliveries"]![0]!["expectedEnvironment"]!.ToString());

            var id = prepared["operationId"]!.ToString(); var calls = 0;
            JsonObject Fake(DeliveryRequest r)
            {
                calls++; Assert.Equal(Env, r.ExpectedEnvironment); Assert.Equal(4516, r.BridgePort);
                return new JsonObject { ["delivered"] = true, ["taskId"] = "t1", ["writeState"] = "applied", ["environment"] = Env };
            }
            Assert.Equal("operation", AccessCommand.Apply(Request("other words", true, id), Fake)["stage"]!.ToString());
            var executed = AccessCommand.Apply(Request("yes, grant the demo roles", true, id), Fake);
            Assert.Equal("delivered", executed["status"]!.ToString());
            Assert.Equal("execute", executed["mode"]!.ToString());
            Assert.True(executed["deliveries"]![0]!["environmentAttested"]!.GetValue<bool>());
            Assert.Equal(Env, executed["deliveries"]![0]!["environment"]!.ToString());
            var again = AccessCommand.Apply(Request("yes, grant the demo roles", true, id), Fake);
            Assert.Equal(1, calls);                                   // a recorded operation returns its receipt, never a second delivery
            Assert.False(again["replayed"]!.GetValue<bool>());
            var ledger = AccessCommand.ReadLedger(work, Env);
            Assert.Equal(1, ledger["App_CS"].ManifestVersion);
            Assert.Equal(id, ledger["App_CS"].OperationId);

            File.AppendAllText(job, " ");
            Assert.Contains(AccessCommand.Apply(Request("yes", false), null)["errors"]!.AsArray(), e => e!.ToString().Contains("planned file changed"));
        }
        finally { try { Directory.Delete(work, true); } catch { } }
    }

    /// <summary>K2 review major 3: the environment attestation is part of the prepared delivery itself. The printed command
    /// carries --expected-environment; the request the CLI builds from that argv (the same parser --execute uses) stops a
    /// Studio connected to another environment before any snapshot or merge; --execute records what the Studio attested
    /// and never writes the ledger for an unattested delivery.</summary>
    [Fact]
    public void Prepared_delivery_attests_the_environment_and_refuses_another()
    {
        var work = Path.Combine(Path.GetTempPath(), "ssam-access-env-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        try
        {
            var manifestPath = FabricatedPlan(work);
            AccessCommand.ApplyRequest Request(bool execute, string? id = null)
                => new(manifestPath, work, "yes", null, id, execute, Path.Combine(work, "deliver-work"), 4536, "dotnet anvil.dll");
            var prepared = AccessCommand.Apply(Request(false), null);
            Assert.Equal(Env, prepared["environmentAttestation"]!["expected"]!.ToString());
            var delivery = prepared["deliveries"]![0]!.AsObject();
            var command = delivery["command"]!.ToString();
            Assert.Contains("--expected-environment " + Env, command);
            Assert.Contains("--port 4536", command);
            Assert.Contains("--work ", command);
            var receipt = File.ReadAllText(prepared["receiptPath"]!.ToString());
            Assert.Contains("--expected-environment", receipt);          // the receipt keeps the attested argv

            var request = AccessCommand.DeliveryRequestOf(delivery);        // what `anvil deliver <argv>` builds
            Assert.Equal(Env, request.ExpectedEnvironment);
            Assert.Equal(4536, request.BridgePort);
            Assert.Equal(Path.Combine(work, "deliver-work"), request.WorkDirectory);

            var bridge = new EnvironmentBridge("personal-other.outsystemscloud.com");
            var refused = Delivery.Run(bridge, request, (_, _, _) => throw new Exception("must not apply on another environment"));
            Assert.False(refused["delivered"]!.GetValue<bool>());
            Assert.Contains("not connected to the accepted environment", refused["error"]!.ToString());
            Assert.Equal("not-sent", refused["writeState"]!.ToString());
            Assert.Equal(new[] { "open_module", "get_active_module" }, bridge.Calls);   // no snapshot, no merge
            Assert.Equal(Env, bridge.OpenedFor);                                        // it even asked Studio for the expected one

            // a resumed or closed task cannot be pointed at another environment either
            Assert.Throws<ArgumentException>(() => DeliverArguments.RequireRecordedEnvironment(["deliver", "--expected-environment", "personal-other.outsystemscloud.com"], request));
            DeliverArguments.RequireRecordedEnvironment(["deliver", "--expected-environment", Env.ToUpperInvariant()], request);
            Assert.Throws<ArgumentException>(() => DeliverArguments.ExpectedEnvironment(["deliver", "--expected-environment", "https://" + Env + "/"]));

            // --execute: a result that does not attest the manifest environment is not a delivery for the ledger
            var id = prepared["operationId"]!.ToString();
            var executed = AccessCommand.Apply(Request(true, id), r => new JsonObject
            {
                ["delivered"] = true, ["taskId"] = "t1", ["writeState"] = "applied", ["environment"] = "personal-other.outsystemscloud.com",
            });
            Assert.Equal("failed", executed["status"]!.ToString());
            Assert.Equal("delivered-unattested", executed["deliveries"]![0]!["status"]!.ToString());
            Assert.False(executed["deliveries"]![0]!["environmentAttested"]!.GetValue<bool>());
            Assert.Empty(AccessCommand.ReadLedger(work, Env));

            // a receipt whose delivery lost its attested argv refuses to execute as a whole
            var legacy = delivery.DeepClone().AsObject(); legacy.Remove("argv");
            Assert.Throws<InvalidOperationException>(() => AccessCommand.DeliveryRequestOf(legacy));
        }
        finally { try { Directory.Delete(work, true); } catch { } }
    }

    /// <summary>K2 review minor 1 (B6 follow-up): --execute runs on the port and delivery store of the prepared argv, which is
    /// what task.json records and what `deliver --resume` must name; a call whose own --port or --deliver-work (explicit or
    /// default) differ is refused before anything is sent, and an uncertain delivery's resume line names both.</summary>
    [Fact]
    public void Execute_runs_on_the_prepared_lane_or_refuses_and_the_resume_line_names_it()
    {
        var work = Path.Combine(Path.GetTempPath(), "ssam-access-lane-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        try
        {
            var manifestPath = FabricatedPlan(work);
            var store = Path.Combine(work, "deliver work");                 // a space: the resume line quotes it
            AccessCommand.ApplyRequest Request(bool execute, int port, string deliverWork, string? id = null)
                => new(manifestPath, work, "yes", null, id, execute, deliverWork, port, "dotnet anvil.dll");
            var prepared = AccessCommand.Apply(Request(false, 9, store), null);
            var id = prepared["operationId"]!.ToString();
            var calls = 0;
            JsonObject Never(DeliveryRequest r) { calls++; throw new Exception("must not deliver"); }

            // the default port of the CLI (4516) is not the prepared one (9): refused, nothing sent, still prepared
            var otherPort = AccessCommand.Apply(Request(true, 4516, store, id), Never);
            Assert.Equal("execute", otherPort["stage"]!.ToString());
            Assert.Contains(otherPort["errors"]!.AsArray(), e => e!.ToString().Contains("Studio port 9 (this call: 4516)") && e.ToString().Contains("--port 9"));
            var otherStore = AccessCommand.Apply(Request(true, 9, Path.Combine(work, "elsewhere"), id), Never);
            Assert.Contains(otherStore["errors"]!.AsArray(), e => e!.ToString().Contains("delivery store") && e.ToString().Contains("--deliver-work \"" + store + "\""));
            Assert.Equal(0, calls);
            Assert.Equal("prepared", AccessCommand.Apply(Request(false, 9, store, id), null)["status"]!.ToString());

            // the matching lane runs; a lost answer leaves a resume line with the task's store and port
            DeliveryRequest? seen = null;
            var uncertain = AccessCommand.Apply(Request(true, 9, store, id), r => { seen = r; throw new IOException("bridge answer lost"); });
            Assert.Equal(9, seen!.BridgePort);
            Assert.Equal(store, seen.WorkDirectory);
            var delivery = uncertain["deliveries"]![0]!;
            Assert.Equal("uncertain", delivery["status"]!.ToString());
            Assert.Equal($"dotnet anvil.dll deliver --resume <taskId> --work \"{store}\" --port 9", delivery["resumeCommand"]!.ToString());
            Assert.Contains(Path.Combine(store, "deliver"), delivery["hint"]!.ToString());
            Assert.Contains("--work \"" + store + "\" --port 9", delivery["hint"]!.ToString());
            Assert.Equal("failed", uncertain["status"]!.ToString());
        }
        finally { try { Directory.Delete(work, true); } catch { } }
    }

    private sealed class EnvironmentBridge(string environment) : IBridgeClient
    {
        public List<string> Calls { get; } = [];
        public string? OpenedFor { get; private set; }
        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            Calls.Add(method);
            switch (method)
            {
                case "open_module": OpenedFor = parameters?["environment"]?.ToString(); return new() { ["opened"] = true };
                case "get_active_module": return new() { ["name"] = "App_CS", ["key"] = "A", ["environment"] = environment };
                default: throw new Exception("Unexpected call on another environment: " + method);
            }
        }
    }

    [Fact]
    public void Verify_is_phase_two()
    {
        var verify = AccessCommand.Verify();
        Assert.False(verify["ok"]!.GetValue<bool>());
        Assert.Equal(2, verify["phase"]!.GetValue<int>());
    }

    /// <summary>The real pipeline over a fixture: read the roles, generate, check-job, apply with Verify, then a second
    /// version updates the same artifacts in place and an older one is refused by the marker the first left in the base.</summary>
    [Fact]
    public void Plan_applies_over_a_fixture_updates_in_place_and_refuses_a_downgrade()
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(AccessPlannerTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "access-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(Path.Combine(work, "model"));
        var roleJob = Path.Combine(work, "role-base.json");
        File.WriteAllText(roleJob, """
            {"expectValid":true,"expectedMessages":[
              {"id":"UnusedElement","element":"Headless_CS (ESpace) / DemoLoginUsernames (SiteProperty)","why":"the fixture only declares the demo allowlist that ssam access reads; no sign-in logic uses it here"},
              {"id":"UnusedElement","element":"Headless_CS (ESpace) / OpsDemoLoginUsernames (SiteProperty)","why":"the same, for the operations allowlist"}],
             "ops":[
              {"op":"create","parent":"@espace","type":"IRole","name":"Operator","as":"$role"},
              {"op":"set","target":"$role","prop":"Description","value":"Operates the fixture."},
              {"op":"set","target":"$role","prop":"IsPersistent","value":true},
              {"op":"create","parent":"@espace","type":"ISiteProperty","name":"DemoLoginUsernames","as":"$demo"},
              {"op":"set","target":"$demo","prop":"DataType","value":"Text"},
              {"op":"set","target":"$demo","prop":"DefaultValue","value":"\"Operator.Demo, viewer.demo\""},
              {"op":"set","target":"$demo","prop":"Description","value":"Demo accounts anyone may sign in as."},
              {"op":"create","parent":"@espace","type":"ISiteProperty","name":"OpsDemoLoginUsernames","as":"$ops"},
              {"op":"set","target":"$ops","prop":"DataType","value":"Text"},
              {"op":"set","target":"$ops","prop":"DefaultValue","value":"\"ops.demo\""},
              {"op":"set","target":"$ops","prop":"Description","value":"Demo accounts of the operations sign-in."}]}
            """);
        var basePath = Path.Combine(work, "Fixture-v1.oml");
        var built = System.Text.Json.JsonSerializer.SerializeToNode(JobRunner.Run(host, Path.Combine(root, "tests", "fixtures", "blank-service.oml"), roleJob, basePath))!;
        Assert.True(built["accepted"]!.GetValue<bool>(), built["details"]?.ToJsonString());
        var facts = AccessBaseReader.Read(host, basePath);
        var module = facts.Module;
        // both allowlists, each by its exact name (a name filter for DemoLoginUsernames also matches OpsDemoLoginUsernames)
        Assert.Equal(new[] { "Operator.Demo", "viewer.demo" }, facts.DemoAllowlists["DemoLoginUsernames"]);
        Assert.Equal(new[] { "ops.demo" }, facts.DemoAllowlists["OpsDemoLoginUsernames"]);

        string WriteManifest(string name, int version, string basePathForModule, string action, string username = "operator.demo", bool create = false)
        {
            var path = Path.Combine(work, name);
            File.WriteAllText(path, new JsonObject
            {
                ["environment"] = Env, ["manifestVersion"] = version, ["bases"] = new JsonObject { [module] = basePathForModule },
                ["entries"] = new JsonArray(new JsonObject { ["username"] = username, ["demo"] = true, ["role"] = module + ".Operator", ["action"] = action, ["createIfMissing"] = create }),
            }.ToJsonString());
            return path;
        }
        JsonObject Plan(string manifest, bool createAccounts = false)
            => AccessCommand.Plan(new(manifest, work, new Dictionary<string, string>(), new Dictionary<string, string>(), createAccounts, false), _ => host);

        // a self-declared demo account outside both lists is refused by the real plan, with or without account creation
        var spoofed = Plan(WriteManifest("m-spoof.json", 1, basePath, "grant", "real.person"));
        Assert.False(spoofed["ok"]!.GetValue<bool>());
        Assert.Contains(spoofed["errors"]!.AsArray(), e => e!.ToString().Contains("demo is derived from the owner module"));
        var spoofCreate = Plan(WriteManifest("m-spoof-create.json", 1, basePath, "grant", "real.person", create: true), createAccounts: true);
        Assert.Contains(spoofCreate["errors"]!.AsArray(), e => e!.ToString().Contains("account creation is limited"));
        Assert.False(Directory.Exists(Path.Combine(work, "plans")) && Directory.GetFiles(Path.Combine(work, "plans"), "*-access.json", SearchOption.AllDirectories).Length > 0);

        var first = Plan(WriteManifest("m1.json", 1, basePath, "grant"));
        Assert.True(first["ok"]!.GetValue<bool>(), first.ToJsonString());
        var m1 = first["modules"]![0]!;
        Assert.Equal("create", m1["mode"]!.ToString());
        // count and normalized sha256 of each allowlist, never the names
        Assert.Equal(2, m1["demoAllowlists"]!["DemoLoginUsernames"]!["count"]!.GetValue<int>());
        Assert.Equal(AccessBaseReader.AllowlistSha256(["operator.demo", "Viewer.Demo"]), m1["demoAllowlists"]!["DemoLoginUsernames"]!["sha256"]!.ToString());
        Assert.Equal(AccessBaseReader.AllowlistSha256(["ops.demo"]), m1["demoAllowlists"]!["OpsDemoLoginUsernames"]!["sha256"]!.ToString());
        Assert.Equal(0, m1["apply"]!["newMessages"]!.GetValue<int>());
        Assert.True(m1["apply"]!["isValid"]!.GetValue<bool>());
        Assert.Equal(0, m1["checkJob"]!["publicActions"]!.GetValue<int>());
        var firstJob = File.ReadAllText(m1["job"]!["path"]!.ToString());
        Assert.Contains("Site.DemoLoginUsernames", firstJob);                        // the run-time guard reads both allowlists in force
        Assert.Contains("Site.OpsDemoLoginUsernames", firstJob);
        var afterFirst = AccessBaseReader.Read(host, m1["apply"]!["out"]!.ToString());
        Assert.Equal(1, afterFirst.Marker!.ManifestVersion);
        Assert.Single(afterFirst.ManifestRecords);
        Assert.Contains(AccessPlanner.DemoAttribute, afterFirst.ManifestAttributes!);

        // the apply receipt carries the same allowlist digests
        var receipt = AccessCommand.Apply(new(Path.Combine(work, "m1.json"), work, "yes", first["planPath"]!.ToString(), null, false,
            Path.Combine(work, "deliver-work"), 9, "dotnet anvil.dll"), null);
        Assert.Equal(m1["demoAllowlists"]!.ToJsonString(), receipt["modules"]![0]!["demoAllowlists"]!.ToJsonString());

        var second = Plan(WriteManifest("m2.json", 2, m1["apply"]!["out"]!.ToString(), "revoke"));
        Assert.True(second["ok"]!.GetValue<bool>(), second.ToJsonString());
        Assert.Equal("update", second["modules"]![0]!["mode"]!.ToString());
        Assert.Equal(0, second["modules"]![0]!["apply"]!["newMessages"]!.GetValue<int>());
        Assert.DoesNotContain("IEntityAttribute", File.ReadAllText(second["modules"]![0]!["job"]!["path"]!.ToString()));
        Assert.Equal(2, AccessBaseReader.Read(host, second["modules"]![0]!["apply"]!["out"]!.ToString()).Marker!.ManifestVersion);

        // a module left by the first generator (AccessManifest without IsDemo, no guard): v2 adds the attribute and the guard
        var v1Job = JsonNode.Parse(firstJob)!.AsObject();
        var skeleton = v1Job["ops"]!.AsArray().OfType<JsonObject>().Single(o => o["op"]!.ToString() == "spec").DeepClone().AsObject();
        var legacyStatic = skeleton["data"]!["static"]![0]!.AsObject();
        var legacyAttributes = legacyStatic["attributes"]!.AsArray();
        legacyAttributes.Remove(legacyAttributes.Single(a => a!["name"]!.ToString() == AccessPlanner.DemoAttribute));
        foreach (var record in legacyStatic["records"]!.AsArray()) record!.AsObject().Remove(AccessPlanner.DemoAttribute);
        // its marker digest was computed under ssam-access-generator/1, so it differs from the /2 digest of the same entries
        var v1Marker = afterFirst.Marker!.Text;
        legacyStatic["description"] = legacyStatic["description"]!.ToString().Replace(v1Marker, new AccessMarker(1, new string('1', 64)).Text);
        Assert.Contains(new string('1', 64), legacyStatic["description"]!.ToString());
        var legacyJob = Path.Combine(work, "legacy-generator-1.json");
        File.WriteAllText(legacyJob, new JsonObject { ["ops"] = new JsonArray(skeleton) }.ToJsonString());
        var legacyBase = Path.Combine(work, "Fixture-legacy-v1.oml");
        var legacyBuilt = System.Text.Json.JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, legacyJob, legacyBase))!;
        Assert.True(File.Exists(legacyBase), legacyBuilt.ToJsonString());
        var legacyFacts = AccessBaseReader.Read(host, legacyBase);
        Assert.Equal(1, legacyFacts.Marker!.ManifestVersion);
        Assert.DoesNotContain(AccessPlanner.DemoAttribute, legacyFacts.ManifestAttributes!);
        var migrated = Plan(WriteManifest("m2-legacy.json", 2, legacyBase, "grant"));
        Assert.True(migrated["ok"]!.GetValue<bool>(), migrated.ToJsonString());
        var mm = migrated["modules"]![0]!;
        Assert.Equal("update", mm["mode"]!.ToString());
        Assert.Equal("changes", mm["status"]!.ToString());
        Assert.Contains("IEntityAttribute", File.ReadAllText(mm["job"]!["path"]!.ToString()));
        Assert.True(mm["apply"]!["isValid"]!.GetValue<bool>(), mm["apply"]!.ToJsonString());
        Assert.Equal(0, mm["apply"]!["newMessages"]!.GetValue<int>());
        Assert.Contains(AccessPlanner.DemoAttribute, AccessBaseReader.Read(host, mm["apply"]!["out"]!.ToString()).ManifestAttributes!);

        var older = Plan(WriteManifest("m0.json", 1, second["modules"]![0]!["apply"]!["out"]!.ToString(), "grant"));
        Assert.False(older["ok"]!.GetValue<bool>());
        Assert.Contains(older["errors"]!.AsArray(), e => e!.ToString().Contains("downgrade refused"));
        Assert.DoesNotContain("operator.demo", File.ReadAllText(first["planPath"]!.ToString()));
    }
}
