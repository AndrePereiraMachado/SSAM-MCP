using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Cascade = Anvil.Core.DatabaseUpgradeRules.Cascade;
using Table = Anvil.Core.DatabaseUpgradeRules.Table;

namespace Anvil.Tests;

/// <summary>
/// DatabaseUpgradeRules: what the database upgrade (publish) refuses and TrueChange lets through, refused on the effective
/// model before delivery. The graph rules run without the Studio (synthetic tables, both lanes, a brute-force oracle over
/// generated graphs); the job cases apply minimal synthetic jobs on blank-service.oml (spec and raw ops, base + job).
/// Shape of the real failure (OfficePet_CS, 2026-10-04): Parent reaches Message directly and through Activity.
/// </summary>
public class DatabaseUpgradeRulesTests
{
    private static Table T(string name, int columns = 4, string kind = "IServerEntity") => new(name, name, kind, columns);
    private static Cascade C(string owner, string attribute, string target, bool owned = true) => new(owner, owner, attribute, target, target, owned);
    private static List<string> Check(IEnumerable<Table> tables, IEnumerable<Cascade> cascades, string lane = "o11", Func<string, string?, DatabaseUpgradeRules.Origin?>? origin = null)
        => DatabaseUpgradeRules.Refusals(tables.ToList(), cascades.ToList(), lane, origin ?? ((_, _) => null));

    private static readonly Table[] Diamond = [T("Parent"), T("Member"), T("Activity"), T("Message")];
    private static Cascade[] DiamondCascades(string messageActivityRule = "Delete") => new[]
    {
        C("Activity", "ParentId", "Parent"), C("Activity", "MemberId", "Member"),
        C("Message", "ParentId", "Parent"), C("Message", "MemberId", "Member"),
        messageActivityRule == "Delete" ? C("Message", "ActivityId", "Activity") : null,
    }.OfType<Cascade>().ToArray();

    [Fact]
    public void TwoCascadePathsToOneTableAreRefusedOnO11WithTheReferenceToChange()
    {
        var lines = Check(Diamond, DiamondCascades());
        Assert.Equal(2, lines.Count);   // one change and the reason
        Assert.Contains("Message.ActivityId: set Delete Rule to Ignore or Protect", lines[0]);
        Assert.Contains("Parent reaches Message by two cascade paths: Parent->Activity->Message [Activity.ParentId, Message.ActivityId] and Parent->Message [Message.ParentId]", lines[0]);
        Assert.Contains("Member reaches Message by two cascade paths: Member->Activity->Message [Activity.MemberId, Message.ActivityId] and Member->Message [Message.MemberId]", lines[0]);
        Assert.StartsWith("Why: on O11 a reference with Delete Rule Delete is a FOREIGN KEY ... ON DELETE CASCADE", lines[1]);
        Assert.Contains("error 1785", lines[1]);
        Assert.Empty(Check(Diamond, DiamondCascades("Ignore")));
    }

    [Fact]
    public void PostgreSqlAcceptsMultipleCascadePathsAndCyclesSoOdcNeverRefusesThem()
    {
        Assert.Empty(Check(Diamond, DiamondCascades(), "odc"));
        Assert.Empty(Check([T("A"), T("B")], [C("A", "BId", "B"), C("B", "AId", "A")], "odc"));
    }

    [Fact]
    public void TwoDeleteReferencesFromOneTableToTheSameTableAreTwoPaths()
    {
        var lines = Check([T("Team"), T("Match")], [C("Match", "HomeTeamId", "Team"), C("Match", "AwayTeamId", "Team")]);
        Assert.Contains("Match.AwayTeamId: set Delete Rule to Ignore or Protect; Team reaches Match by two cascade paths: Team->Match [Match.AwayTeamId] and Team->Match [Match.HomeTeamId]", lines[0]);
        Assert.Equal(2, lines.Count);
    }

    [Fact]
    public void ACascadeCycleIsRefusedAndASelfReferenceIsLeftToTrueChange()
    {
        var lines = Check([T("A"), T("B")], [C("A", "BId", "B"), C("B", "AId", "A")]);
        Assert.Contains("cascade cycle", lines[0]);
        Assert.Matches(@"cascade cycle (A->B->A \[B\.AId, A\.BId\]|B->A->B \[A\.BId, B\.AId\])", lines[0]);
        // InvalidAttribute_BadDeleteRule ("'Delete Rule' of self-referencing {0} cannot be set to 'Delete'") is the Studio's.
        Assert.Empty(Check([T("Node")], [C("Node", "ParentId", "Node")]));
    }

    [Fact]
    public void ProtectAndIgnoreNeverCascadeAndASingleTreeOfCascadesPasses()
    {
        // Only Delete references reach the rule; a tree (each table reached by one path from any table) is accepted.
        Assert.Empty(Check([T("Order"), T("Line"), T("Note"), T("Customer")],
            [C("Order", "CustomerId", "Customer"), C("Line", "OrderId", "Order"), C("Note", "LineId", "Line")]));
    }

    [Fact]
    public void ReferencedModuleCascadesJoinTheGraphButOnlyThisModulesTablesAreRefused()
    {
        // Producer: User -> Profile (Delete, owned by the producer). This module: Profile -> Ticket and User -> Ticket.
        var tables = new[] { T("Ticket") };
        var cascades = new[] { C("Profile", "UserId", "User", owned: false), C("Ticket", "ProfileId", "Profile"), C("Ticket", "UserId", "User") };
        var lines = Check(tables, cascades);
        Assert.Contains("User reaches Ticket by two cascade paths", lines[0]);
        Assert.Contains("Ticket.ProfileId: set Delete Rule to Ignore or Protect", lines[0]);   // the last hop of the longer path
        // A conflict only among the producer's tables is not this publish's (its constraints already exist).
        Assert.Empty(Check([T("Ticket")], [C("X", "AId", "A", owned: false), C("X", "A2Id", "A", owned: false)]));
    }

    [Fact]
    public void TheJobsOwnReferenceIsChangedBeforeOneAlreadyInTheModule()
    {
        // The base had Parent->Message and Parent->Activity; the job adds Message.ActivityId (op #3) and makes the conflict.
        var tables = new[] { T("Parent"), T("Activity"), T("Message") };
        var cascades = new[] { C("Activity", "ParentId", "Parent"), C("Message", "ParentId", "Parent"), C("Message", "ActivityId", "Activity") };
        var lines = Check(tables, cascades, origin: (entity, attribute) => entity == "Message" && attribute == "ActivityId" ? new(3, "set") : null);
        Assert.StartsWith("op #3 (set Message.ActivityId): Message.ActivityId: set Delete Rule to Ignore or Protect", lines[0]);
        Assert.Contains("{\"op\":\"set\",\"target\":\"IServerEntity:Message/ActivityId\",\"prop\":\"DeleteRule\",\"value\":\"Ignore\"}", lines[0]);
        // Without the job's reference the conflict is all the module's: it is still refused (the publish would fail), and said so.
        var baseOnly = Check(tables, cascades);
        Assert.Contains("(already in the module, not set by this job)", baseOnly[0]);
    }

    [Fact]
    public void TheAnswerIsDeterministicWhateverTheReadingOrder()
    {
        var cascades = DiamondCascades().Concat([C("Match", "HomeTeamId", "Team"), C("Match", "AwayTeamId", "Team"), C("A", "BId", "B"), C("B", "AId", "A")]).ToArray();
        var tables = Diamond.Concat([T("Team"), T("Match"), T("A"), T("B")]).ToArray();
        var expected = Check(tables, cascades);
        var random = new Random(20261005);
        for (var i = 0; i < 20; i++)
            Assert.Equal(expected, Check(tables.OrderBy(_ => random.Next()), cascades.OrderBy(_ => random.Next())));
    }

    /// <summary>The oracle: SQL Server accepts the cascades iff they have no cycle and no pair of tables joined by two
    /// cascade paths (counted by brute force). On generated graphs the rule refuses exactly then, and setting aside every
    /// reference it names always leaves an accepted graph.</summary>
    [Fact]
    public void OnGeneratedGraphsTheRuleAgreesWithBruteForceAndItsFixAlwaysPasses()
    {
        var random = new Random(1785);
        for (var round = 0; round < 400; round++)
        {
            var n = random.Next(2, 8);
            var tables = Enumerable.Range(0, n).Select(i => T("E" + i)).ToArray();
            var cascades = new List<Cascade>();
            var edges = random.Next(0, 10);
            for (var k = 0; k < edges; k++)
            {
                var from = random.Next(n); var to = random.Next(n);
                if (from != to) cascades.Add(C("E" + to, "R" + k, "E" + from));
            }
            var refused = Check(tables, cascades).Count > 0;
            Assert.Equal(Unsafe(cascades), refused);
            var fixes = DatabaseUpgradeRules.Fixes(cascades, tables.Select(t => t.Key).ToHashSet());
            Assert.False(Unsafe(cascades.Except(fixes).ToList()), $"round {round}: still refused after the listed changes");
            Assert.Equal(refused, fixes.Count > 0);
        }
    }

    private static bool Unsafe(IReadOnlyList<Cascade> cascades)
    {
        var outgoing = cascades.GroupBy(e => e.Target).ToDictionary(g => g.Key, g => g.ToList());
        var nodes = cascades.SelectMany(e => new[] { e.Owner, e.Target }).Distinct().ToList();
        var state = new Dictionary<string, int>();
        bool Cyclic(string v)
        {
            state[v] = 1;
            foreach (var e in outgoing.GetValueOrDefault(v) ?? [])
                if (state.GetValueOrDefault(e.Owner) == 1 || state.GetValueOrDefault(e.Owner) == 0 && Cyclic(e.Owner)) return true;
            state[v] = 2; return false;
        }
        if (nodes.Any(v => state.GetValueOrDefault(v) == 0 && Cyclic(v))) return true;
        long Count(string from, string to) => from == to ? 1 : (outgoing.GetValueOrDefault(from) ?? []).Sum(e => Count(e.Owner, to));
        return nodes.Any(source => nodes.Any(t => t != source && Count(source, t) > 1));
    }

    [Fact]
    public void TablesOverTheColumnLimitOfTheLaneAreRefused()
    {
        var o11 = Check([T("Wide", 1025)], []);
        Assert.Contains("entity Wide has 1025 attributes", Assert.Single(o11));
        Assert.Contains("SQL Server (O11) holds at most 1024 columns per table", o11[0]);
        Assert.Empty(Check([T("Wide", 1024)], []));
        Assert.Empty(Check([T("Wide", 1025)], [], "odc"));
        Assert.Contains("PostgreSQL (ODC) holds at most 1600 columns per table", Assert.Single(Check([T("Wide", 1601)], [], "odc")));
    }

    [Fact]
    public void TheRefusalNamesTheOpOfTheJobThatDeclaresTheReference()
    {
        var ops = JsonNode.Parse("""
        [{"op":"spec","data":{"entities":[{"name":"Message","attributes":[{"name":"ActivityId","type":"Activity Identifier","deleteRule":"Delete"}]}]}},
         {"op":"create","parent":"IServerEntity:Activity","type":"IEntityAttribute","name":"OwnerId","as":"$owner"},
         {"op":"set","target":"$owner","prop":"DataType","value":"Parent Identifier"},
         {"op":"set","target":"$owner","prop":"DeleteRule","value":"Delete"},
         {"op":"set","target":"IServerEntity:Note/ParentId","prop":"DeleteRule","value":"Delete"}]
        """)!.AsArray();
        Assert.Equal(new DatabaseUpgradeRules.Origin(0, "spec"), DatabaseUpgradeRules.Declared(ops, "Message", "ActivityId"));
        Assert.Equal(new DatabaseUpgradeRules.Origin(3, "set"), DatabaseUpgradeRules.Declared(ops, "Activity", "OwnerId"));
        Assert.Equal(new DatabaseUpgradeRules.Origin(4, "set"), DatabaseUpgradeRules.Declared(ops, "Note", "ParentId"));
        Assert.Equal(new DatabaseUpgradeRules.Origin(0, "spec"), DatabaseUpgradeRules.Declared(ops, "Message", null));
        Assert.Null(DatabaseUpgradeRules.Declared(ops, "Message", "Other"));
    }

    // ---- the effective model: synthetic jobs applied on blank-service.oml -------------------------------------------

    private const string DiamondSpec = """
        {"op":"spec","data":{"entities":[
          {"name":"DuParent","attributes":[{"name":"Name","type":"Text","length":50}]},
          {"name":"DuMember","attributes":[{"name":"Name","type":"Text","length":50}]},
          {"name":"DuActivity","attributes":[{"name":"ParentId","type":"DuParent Identifier","mandatory":true,"deleteRule":"Delete"},
                                              {"name":"MemberId","type":"DuMember Identifier","mandatory":true,"deleteRule":"Delete"}]},
          {"name":"DuMessage","attributes":[{"name":"ParentId","type":"DuParent Identifier","mandatory":true,"deleteRule":"Delete"},
                                             {"name":"MemberId","type":"DuMember Identifier","deleteRule":"Delete"},
                                             {"name":"ActivityId","type":"DuActivity Identifier","deleteRule":"RULE"},
                                             {"name":"Content","type":"Text","length":200}]}]}}
        """;

    [Fact]
    public void TheSpecJobIsRefusedBeforeSavingAndTheSameJobWithIgnorePasses()
    {
        if (!StudioAvailable()) return;
        var refused = Assert.Throws<InvalidOperationException>(() => Run("du-diamond", "blank-service.oml", DiamondSpec.Replace("RULE", "Delete")));
        var text = Errors.Text(refused);
        Assert.Contains("op #0 (spec DuMessage.ActivityId): DuMessage.ActivityId: set Delete Rule to Ignore or Protect", text);
        Assert.Contains("DuParent reaches DuMessage by two cascade paths", text);
        Assert.Contains("DuMember reaches DuMessage by two cascade paths", text);
        Assert.Contains("\"deleteRule\":\"Ignore\" (or \"Protect\") on attribute ActivityId of DuMessage", text);
        Assert.False(File.Exists(Path.Combine(work, "du-diamond.oml")), "the candidate must not be saved");
        foreach (var rule in new[] { "Ignore", "Protect" })
        {
            var passed = Run("du-diamond-" + rule.ToLowerInvariant(), "blank-service.oml", DiamondSpec.Replace("RULE", rule));
            Assert.True(passed["accepted"]!.GetValue<bool>(), passed["policyMessages"]?.ToJsonString());
        }
    }

    [Fact]
    public void RawOpsOverABaseThatAlreadyCascadesAreReadOnTheEffectiveModel()
    {
        if (!StudioAvailable()) return;
        var built = Run("du-base", "blank-service.oml", DiamondSpec.Replace("RULE", "Ignore"));
        Assert.True(built["accepted"]!.GetValue<bool>());
        var basePath = built["outPath"]!.ToString();
        // Only the raw set is in the job: the two other paths come from the base module.
        var refused = Assert.Throws<InvalidOperationException>(() => Run("du-raw", basePath,
            """{"op":"set","target":"IServerEntity:DuMessage/ActivityId","prop":"DeleteRule","value":"Delete"}"""));
        var text = Errors.Text(refused);
        Assert.Contains("op #0 (set DuMessage.ActivityId): DuMessage.ActivityId: set Delete Rule to Ignore or Protect", text);
        Assert.Contains("{\"op\":\"set\",\"target\":\"IServerEntity:DuMessage/ActivityId\",\"prop\":\"DeleteRule\",\"value\":\"Ignore\"}", text);
        // A raw attribute created by the job with its own type and rule.
        var created = Assert.Throws<InvalidOperationException>(() => Run("du-raw-create", basePath,
            """{"op":"create","parent":"IServerEntity:DuMessage","type":"IEntityAttribute","name":"SecondParentId","as":"$second"}""",
            """{"op":"set","target":"$second","prop":"DataType","value":"DuParent Identifier"}""",
            """{"op":"set","target":"$second","prop":"DeleteRule","value":"Delete"}"""));
        Assert.Contains("op #2 (set DuMessage.SecondParentId): DuMessage.SecondParentId: set Delete Rule to Ignore or Protect", Errors.Text(created));
        // The same raw set with Protect is no cascade: accepted.
        var protect = Run("du-raw-protect", basePath, """{"op":"set","target":"IServerEntity:DuMessage/ActivityId","prop":"DeleteRule","value":"Protect"}""");
        Assert.True(protect["accepted"]!.GetValue<bool>(), protect["policyMessages"]?.ToJsonString());
    }

    private readonly string work = Path.Combine(Root, ".local", "db-upgrade-rules-tests", Guid.NewGuid().ToString("N"));

    private JsonNode Run(string name, string basePath, params string[] ops)
    {
        StudioAssemblies.Bind();
        Directory.CreateDirectory(work);
        var job = Path.Combine(work, name + ".json");
        File.WriteAllText(job, "{\"ops\":[" + string.Join(",", ops) + "]}");
        var resolvedBase = Path.IsPathRooted(basePath) ? basePath : Path.Combine(Root, "tests", "fixtures", basePath);
        return JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(work), resolvedBase, job, Path.Combine(work, name + ".oml")))!;
    }

    private static bool StudioAvailable()
    {
        try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; }
    }

    private static string Root => JobRunner.RepoRoot(Path.GetDirectoryName(typeof(DatabaseUpgradeRulesTests).Assembly.Location)!)!;
}
