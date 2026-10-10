using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using OutSystems.Model;
using OutSystems.Model.Merge;
using ServiceStudio.Model;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// The merge order of the ODC bridge (platforms/odc/studio/engine/NativeMergeOrder.cs, linked here) over the ODC Studio's own
/// model and MatchTree, headless. The bridge passes CompareAndMergeCommands.CompareAndMerge as the merge; here the same tree
/// merges inside the module's transaction. QuizLiveWeb on 2026-10-04 lost Partida.StatusId and Quiz.DificuldadeId this way
/// (native-equivalence.txt of lab 24): the plan names them, one merge drops exactly them, two merges land the candidate, and
/// the bridge's verification names a loss of that class instead of answering uncertain.
/// </summary>
public class OdcMergeOrderTests
{
    private static string Root { get { var d = Path.GetDirectoryName(typeof(OdcMergeOrderTests).Assembly.Location); while (d != null && !File.Exists(Path.Combine(d, "MANIFESTO.md"))) d = Path.GetDirectoryName(d); return d!; } }
    private const string Job = """
    {"ops":[{"op":"spec","data":{
      "static":[{"name":"PartidaStatus","public":true,"records":[{"name":"Aguardando","id":1},{"name":"Encerrada","id":2}]},
                {"name":"Dificuldade","public":true,"records":[{"name":"Facil","id":1},{"name":"Medio","id":2}]}],
      "entities":[{"name":"Quiz","public":true,"attributes":[{"name":"Titulo","type":"Text","length":100},{"name":"DificuldadeId","type":"Dificuldade Identifier","default":"Entities.Dificuldade.Medio"},{"name":"Rodadas","type":"Integer","default":"10"}]},
                  {"name":"Partida","public":true,"attributes":[{"name":"QuizId","type":"Quiz Identifier"},{"name":"StatusId","type":"PartidaStatus Identifier","default":"Entities.PartidaStatus.Aguardando"}]}]}}]}
    """;
    private static readonly string[] Deferred = ["Partida.StatusId = Entities.PartidaStatus.Aguardando", "Quiz.DificuldadeId = Entities.Dificuldade.Medio"];

    [Fact]
    public void ThePlanNamesWhatOneMergeDropsAndTwoMergesLandTheCandidate()
    {
        if (!StudioAvailable()) return;
        Run();
    }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static void Run()
    {
        var dir = Path.Combine(Root, ".local", "lane-odc", "merge-order-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir);
        var host = new ModelHost(dir);
        var basePath = Path.Combine(Root, "tests", "fixtures", "odc", "blank-mobile.oml");
        var jobPath = Path.Combine(dir, "quiz-data-model.json"); File.WriteAllText(jobPath, Job);
        var foreignPath = Path.Combine(dir, "candidate.oml");
        var applied = JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, jobPath, foreignPath))!;
        Assert.True(applied["accepted"]!.GetValue<bool>(), applied["policyMessages"]?.ToJsonString());
        var baseBytes = File.ReadAllBytes(basePath); var candidateBytes = File.ReadAllBytes(foreignPath);
        ESpace Load(byte[] bytes) => host.Load(bytes);

        // The plan, from the loaded candidate and base, as the bridge computes it.
        NativeMergeOrder.Plan order;
        using (var candidate = Load(candidateBytes)) using (var basis = Load(baseBytes)) order = NativeMergeOrder.Prepare(candidate, basis, candidateBytes, Load);
        Assert.Equal(Deferred, order.Deferred.Select(d => d.Element + " = " + d.Value).Order(StringComparer.Ordinal));
        Assert.NotNull(order.FirstPass);

        // One merge (the bridge before the merge order): exactly the planned defaults are lost, in the dump shape of lab 24.
        var single = Load(baseBytes);
        try
        {
            using (var basis = Load(baseBytes)) Merge(single, Load(candidateBytes), basis);
            using var expected = Load(candidateBytes);
            var lost = MergeOrder.Lost(single, expected);
            Assert.Equal(Deferred, lost.Select(d => d.Element + " = " + d.Value).Order(StringComparer.Ordinal));
            Assert.Equal(lost.Select(d => d.Key), MergeOrder.Missing(single, order.Deferred).Select(d => d.Key));
            var output = Path.Combine(dir, "single-native-equivalence.txt");
            var refused = Assert.Throws<InvalidOperationException>(() => NativeMergeVerification.Verify(single, expected, new HashSet<string>(), output));
            Assert.Contains("lost or conflicts", refused.Message);
            var dump = File.ReadAllText(output);
            foreach (var d in Deferred) Assert.Contains("Default Value[] / Default Value[" + d.Split(" = ")[1] + "] [RemovedFromLocal]", dump);
            // The known class: with the lost defaults named, everything else is proven equal.
            var named = lost.Select(d => new NativeMergeVerification.LostDefault(d.Element.Split('.')[0], d.Element.Split('.')[1], d.Value)).ToArray();
            var proof = NativeMergeVerification.Verify(single, expected, new HashSet<string>(), output, named);
            Assert.True(proof.NativeSemanticEquivalent);
            Assert.False(proof.StrictlyEqual);
            var repair = MergeOrder.RepairJob(lost)["ops"]!.AsArray();
            Assert.Equal(lost.Select(d => "@" + d.ObjectKey), repair.Select(op => op!["target"]!.ToString()));
        }
        finally { ModelHost.Release(single); }

        // Two merges (the bridge now): the first-pass copy over the base, then the candidate over the copy.
        var live = Load(baseBytes);
        try
        {
            using (var basis = Load(baseBytes)) Merge(live, Load(order.FirstPass!), basis);
            var second = NativeMergeOrder.SecondPass(live, candidateBytes, order.FirstPass!, Load, (into, foreign, over) => { Merge(into, foreign, over); return "Merge"; });
            Assert.True(second.Merged, second.Reason);
            Assert.False(second.Conflicts);
            using var expected = Load(candidateBytes);
            Assert.Empty(MergeOrder.Lost(live, expected));
            Assert.Empty(MergeOrder.Missing(live, order.Deferred));
            var proof = NativeMergeVerification.Verify(live, expected, new HashSet<string>(), Path.Combine(dir, "native-equivalence.txt"));
            Assert.True(proof.NativeSemanticEquivalent);
            Assert.True(proof.StrictlyEqual);
        }
        finally { ModelHost.Release(live); }
    }

    // The delivery that failed live on 2026-10-08 (ODC Studio 1.7.27, bridge v45): an entity whose mandatory Identifier
    // attribute has a default. The bridge's NativeMergeOrder.Prepare built its first-pass copy in a transaction that threw
    // NullReferenceException inside the Studio. The facade now plans the order headless (anvil-odc merge-order, this
    // MergePlanner) and hands the bridge two merges whose own plan is empty: Prepare returns before its transaction.
    private const string TrailJob = """
    {"ops":[{"op":"spec","data":{
      "static":[{"name":"Difficulty","public":true,"records":[{"name":"Easy","id":1},{"name":"Hard","id":2}]}],
      "entities":[{"name":"Trail","attributes":[{"name":"Name","type":"Text","mandatory":true,"length":100},
        {"name":"DifficultyId","type":"Difficulty Identifier","mandatory":true,"default":"Entities.Difficulty.Easy"},
        {"name":"IsActive","type":"Boolean","default":"True"}]}]}}]}
    """;

    [Fact]
    public void TheHeadlessPlanGivesTheBridgeTwoMergesWithAnEmptyOwnPlan()
    {
        if (!StudioAvailable()) return;
        RunTrail();
    }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static void RunTrail()
    {
        var dir = Path.Combine(Root, ".local", "lane-odc", "merge-order-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir);
        var host = new ModelHost(dir);
        var basePath = Path.Combine(Root, "tests", "fixtures", "odc", "blank-mobile.oml");
        var jobPath = Path.Combine(dir, "trail.json"); File.WriteAllText(jobPath, TrailJob);
        var candidatePath = Path.Combine(dir, "candidate.oml");
        var applied = JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, jobPath, candidatePath))!;
        Assert.True(applied["accepted"]!.GetValue<bool>(), applied["policyMessages"]?.ToJsonString());
        ESpace Load(byte[] bytes) => host.Load(bytes);
        string? DefaultOf(ESpace model, string attribute) => model.GetAllChildrenOfType<ServiceStudio.Model.Interfaces.IObjectWithDefaultValue>()
            .Where(o => o is AbstractObject a && a.Name == attribute && a.GetParent()?.Name == "Trail").Select(o => o.DefaultValue?.GetText() ?? "").Single();

        // The plan on files, as `anvil-odc merge-order` writes it: the deferred default and the first-pass candidate.
        var firstPassPath = Path.Combine(dir, "first-pass.oml");
        var plan = new MergePlanner(_ => host).Plan(basePath, candidatePath, firstPassPath);
        var deferred = MergeOrder.FromJson(plan["deferred"]!.AsArray());
        Assert.Equal(["Trail.DifficultyId = Entities.Difficulty.Easy"], deferred.Select(d => d.Element + " = " + d.Value));
        Assert.Equal(firstPassPath, plan["firstPass"]!.ToString());
        var baseBytes = File.ReadAllBytes(basePath); var candidateBytes = File.ReadAllBytes(candidatePath); var firstPassBytes = File.ReadAllBytes(firstPassPath);

        // Merge 1 receives the first pass: no default on the attribute it creates (the other defaults stay), so the bridge's
        // own plan is empty and Prepare returns before the transaction.
        using (var firstPass = Load(firstPassBytes))
        {
            Assert.Equal("", DefaultOf(firstPass, "DifficultyId"));
            Assert.Equal("True", DefaultOf(firstPass, "IsActive"));
            using var basis = Load(baseBytes);
            var bridgePlan = NativeMergeOrder.Prepare(firstPass, basis, firstPassBytes, _ => throw new InvalidOperationException("Prepare loaded a copy: it would run its transaction"));
            Assert.Empty(bridgePlan.Deferred); Assert.Null(bridgePlan.FirstPass);
        }
        var live = Load(baseBytes);
        try
        {
            using (var basis = Load(baseBytes)) Merge(live, Load(firstPassBytes), basis);
            // Merge 2 receives the full candidate over the module captured after merge 1: the element exists, the bridge's
            // plan is empty again, and the default is merged onto it.
            var afterFirst = host.Save(live);
            using (var candidate = Load(candidateBytes)) using (var captured = Load(afterFirst))
            {
                Assert.Equal("Entities.Difficulty.Easy", DefaultOf(candidate, "DifficultyId"));
                var bridgePlan = NativeMergeOrder.Prepare(candidate, captured, candidateBytes, _ => throw new InvalidOperationException("Prepare loaded a copy: it would run its transaction"));
                Assert.Empty(bridgePlan.Deferred); Assert.Null(bridgePlan.FirstPass);
            }
            using (var captured = Load(afterFirst)) Merge(live, Load(candidateBytes), captured);
            using var expected = Load(candidateBytes);
            Assert.Equal("Entities.Difficulty.Easy", DefaultOf(live, "DifficultyId"));
            Assert.Empty(MergeOrder.Lost(live, expected));
            Assert.Empty(MergeOrder.Missing(live, deferred));
            Assert.True(NativeMergeVerification.Verify(live, expected, new HashSet<string>(), Path.Combine(dir, "trail-native-equivalence.txt")).StrictlyEqual);
        }
        finally { ModelHost.Release(live); }
    }

    // The headless stand-in of CompareAndMergeCommands.CompareAndMerge: the same MatchTree, merged in the module's transaction.
    private static void Merge(ESpace local, ESpace foreign, ESpace basis)
    {
        try { ((IESpace)local).TransactionsManager.ExecuteTransaction("test: native merge", (_, _) => { using var tree = new MatchTree(local, foreign, basis, false, true); Assert.False(tree.HasConflicts); tree.Merge(); return true; }); }
        finally { ModelHost.Release(foreign); }
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(); return true; } catch { return false; }
    }
}
