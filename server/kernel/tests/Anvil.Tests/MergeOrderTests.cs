using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// The merge order (MergeOrder) over the Service Studio's own MatchTree, headless: the same merge code the bridge runs in the
/// Studio (MergeProbe.Replay mirrors merge_from_oml with first_pass_path). The Studio removes a Default Value it marks
/// read-only when a merge sets the element's type or mandatory flag: on 2026-10-03/04 GameStore_CS (Order.OrderStatusId),
/// OfficePet_CS (Pet.SpeciesId, Pet.StageId) and QuizLiveWeb (ODC) lost such defaults on attributes the delivery created.
/// The plan names exactly what one merge drops, and the two merges of one delivery land the candidate unchanged.
/// </summary>
public class MergeOrderTests
{
    private static string Root => JobRunner.RepoRoot(Path.GetDirectoryName(typeof(MergeOrderTests).Assembly.Location)!)!;
    private static string Fixture => Path.Combine(Root, "tests", "fixtures", "blank-service.oml");
    private const string Species = """{"name":"Species","public":true,"records":[{"name":"Dog","id":1},{"name":"Cat","id":2}]}""";

    // Every class at once: identifier defaults on a new entity, on a static entity, NullIdentifier(), a mandatory input
    // parameter; and the controls the Studio keeps (an Integer default, an optional input, a local variable, a record value
    // that references a record of the same job).
    private const string AllClasses = """
    {"ops":[
     {"op":"spec","data":{
       "static":[SPECIES,
         {"name":"Stat","public":true,"records":[{"name":"Hunger","id":1}]},
         {"name":"Kind","public":true,"attributes":[{"name":"StatId","type":"Stat Identifier"},{"name":"SpeciesId","type":"Species Identifier","default":"Entities.Species.Dog"}],
          "records":[{"name":"Feed","id":1,"StatId":"Entities.Stat.Hunger"}]}],
       "entities":[{"name":"Pet","public":true,"attributes":[{"name":"Name","type":"Text","length":30},
         {"name":"SpeciesId","type":"Species Identifier","mandatory":true,"default":"Entities.Species.Dog"},
         {"name":"FavoriteId","type":"Species Identifier","default":"NullIdentifier()"},
         {"name":"Weight","type":"Integer","default":"3"}]}]}},
     {"op":"logic","data":{"actions":[{"name":"Pick","kind":"server","public":true,
       "inputs":[{"name":"In","type":"Species Identifier","default":"Entities.Species.Cat"},{"name":"Optional","type":"Species Identifier","mandatory":false,"default":"Entities.Species.Dog"}],
       "outputs":[{"name":"Out","type":"Species Identifier"}],"vars":[{"name":"Local","type":"Species Identifier","default":"Entities.Species.Dog"}],
       "steps":[{"assign":{"Out":"If(In = Entities.Species.Cat, Optional, Local)"}}]}]}}]}
    """;
    private static readonly string[] Deferred = ["Kind.SpeciesId = Entities.Species.Dog", "Pet.FavoriteId = NullIdentifier()", "Pet.SpeciesId = Entities.Species.Dog", "Pick.In = Entities.Species.Cat"];

    [Fact]
    public void ThePlanNamesExactlyTheDefaultsOneNativeMergeDrops()
    {
        var (host, dir, foreign, assertions) = Apply("classes", Fixture, AllClasses);
        var baseBytes = File.ReadAllBytes(Fixture);
        var (deferred, firstPass) = MergeProbe.Plan(host, baseBytes, File.ReadAllBytes(foreign));
        Assert.Equal(Deferred, deferred.Select(d => d.Element + " = " + d.Value).Order(StringComparer.Ordinal));
        Assert.NotNull(firstPass);
        Assert.All(deferred, d => Assert.Null(d.BaseValue));
        // Deterministic: the same models give the same plan, key by key.
        Assert.Equal(deferred, MergeProbe.Plan(host, baseBytes, File.ReadAllBytes(foreign)).Deferred);

        // One native merge (the bridges before the merge order) loses exactly those defaults and nothing else.
        var single = Path.Combine(dir, "single-pass.oml");
        var probe = MergeProbe.ThreeWay(host, baseBytes, File.ReadAllBytes(foreign), single, singlePass: true);
        Assert.False(probe.HasConflicts);
        var lostLines = Differences(host, single, foreign).Where(l => l.Contains(">>", StringComparison.Ordinal)).ToArray();
        Assert.Equal(Deferred.Length, lostLines.Length);
        foreach (var d in deferred) Assert.Contains(lostLines, l => l.Contains("Default Value[] / Default Value[" + d.Value + "] [RemovedFromLocal]", StringComparison.Ordinal));
        var proof = host.CheckDataContract(single, assertions);
        Assert.Equal(["Kind.SpeciesId", "Pet.FavoriteId", "Pet.SpeciesId"], proof["differences"]!.AsArray()
            .Select(x => { Assert.Equal("DefaultValue", x!["property"]!.ToString()); return Short(x["element"]!.ToString()); }).Order(StringComparer.Ordinal));
    }

    [Fact]
    public void TheTwoNativeMergesOfOneDeliveryLandTheCandidateUnchanged()
    {
        var (host, dir, foreign, assertions) = Apply("two-pass", Fixture, AllClasses);
        var merged = Path.Combine(dir, "merged.oml");
        var probe = MergeProbe.ThreeWay(host, File.ReadAllBytes(Fixture), File.ReadAllBytes(foreign), merged);
        Assert.False(probe.HasConflicts);
        Assert.Equal(0, probe.Errors);
        Assert.Equal(probe.ForeignObjects, probe.LocalObjects);
        Assert.Equal(Deferred, probe.Deferred!.Select(d => d.Element + " = " + d.Value).Order(StringComparer.Ordinal));
        Assert.Empty(Differences(host, merged, foreign));
        Assert.True(host.CheckDataContract(merged, assertions)["accepted"]!.GetValue<bool>());
    }

    [Fact]
    public void TheDeliveryMergeKeepsTheDefaultsOfAttributesItCreates()
    {
        // OfficePet_CS of 2026-10-04, reduced: the delivery's headless merge keeps Pet.SpeciesId and Pet.StageId. Only the
        // API the bridge had before the merge order (ThreeWay, CheckDataContract): this is the regression that fails on 63137c28.
        var (host, dir, foreign, assertions) = Apply("officepet", Fixture, """
        {"ops":[{"op":"spec","data":{"static":[SPECIES,{"name":"Stage","public":true,"records":[{"name":"Egg","id":1}]}],
          "entities":[{"name":"Pet","public":true,"attributes":[{"name":"Name","type":"Text","length":30},
            {"name":"SpeciesId","type":"Species Identifier","mandatory":true,"default":"Entities.Species.Dog"},
            {"name":"StageId","type":"Stage Identifier","mandatory":true,"default":"Entities.Stage.Egg"}]}]}}]}
        """);
        var merged = Path.Combine(dir, "merged.oml");
        MergeProbe.ThreeWay(host, File.ReadAllBytes(Fixture), File.ReadAllBytes(foreign), merged);
        var proof = host.CheckDataContract(merged, assertions);
        Assert.True(proof["accepted"]!.GetValue<bool>(), proof["differences"]!.ToJsonString());
    }

    [Fact]
    public void AnIdentifierDefaultIsDeferredAlsoWhenItsStaticEntityAlreadyExists()
    {
        // Not the creation order of the record: the attribute's type is set by the merge that creates the attribute.
        var (host, dir, baseOml, _) = Apply("existing-static", Fixture, """{"ops":[{"op":"spec","data":{"static":[SPECIES]}}]}""");
        var (_, _, foreign, assertions) = Apply("existing-static-entity", baseOml,
            """{"ops":[{"op":"spec","data":{"entities":[{"name":"Pet","public":true,"attributes":[{"name":"SpeciesId","type":"Species Identifier","default":"Entities.Species.Dog"}]}]}}]}""", dir);
        var merged = Path.Combine(dir, "merged.oml");
        var probe = MergeProbe.ThreeWay(host, File.ReadAllBytes(baseOml), File.ReadAllBytes(foreign), merged);
        Assert.Equal(["Pet.SpeciesId = Entities.Species.Dog"], probe.Deferred!.Select(d => d.Element + " = " + d.Value));
        Assert.Empty(Differences(host, merged, foreign));
        Assert.True(host.CheckDataContract(merged, assertions)["accepted"]!.GetValue<bool>());
    }

    [Fact]
    public void ADefaultSetOnAnExistingAttributeNeedsOneMerge()
    {
        // The GameStore_CS repair of 2026-10-03: the attribute existed, its type was not set again, the default stayed.
        var (host, dir, baseOml, _) = Apply("existing-attribute", Fixture,
            """{"ops":[{"op":"spec","data":{"static":[SPECIES],"entities":[{"name":"Pet","public":true,"attributes":[{"name":"SpeciesId","type":"Species Identifier"}]}]}}]}""");
        var (_, _, foreign, assertions) = Apply("existing-attribute-default", baseOml,
            """{"ops":[{"op":"set","target":"IServerEntity:Pet/SpeciesId","prop":"DefaultValue","value":"Entities.Species.Dog"}]}""", dir);
        var (deferred, firstPass) = MergeProbe.Plan(host, File.ReadAllBytes(baseOml), File.ReadAllBytes(foreign));
        Assert.Empty(deferred);
        Assert.Null(firstPass);
        var single = Path.Combine(dir, "single.oml");
        MergeProbe.ThreeWay(host, File.ReadAllBytes(baseOml), File.ReadAllBytes(foreign), single, singlePass: true);
        Assert.Empty(Differences(host, single, foreign));
        Assert.True(host.CheckDataContract(single, assertions)["accepted"]!.GetValue<bool>());
    }

    [Fact]
    public void ARetypedAttributeDefersItsDefault()
    {
        // The merge sets the type of an existing attribute: the same removal, the same order.
        var (host, dir, baseOml, _) = Apply("retyped", Fixture,
            """{"ops":[{"op":"spec","data":{"static":[SPECIES],"entities":[{"name":"Pet","public":true,"attributes":[{"name":"SpeciesId","type":"Integer","default":"1"}]}]}}]}""");
        var (_, _, foreign, assertions) = Apply("retyped-identifier", baseOml,
            """{"ops":[{"op":"set","target":"IServerEntity:Pet/SpeciesId","prop":"DefaultValue","value":""},{"op":"set","target":"IServerEntity:Pet/SpeciesId","prop":"DataType","value":"Species Identifier"},{"op":"set","target":"IServerEntity:Pet/SpeciesId","prop":"DefaultValue","value":"Entities.Species.Cat"}]}""", dir);
        var merged = Path.Combine(dir, "merged.oml");
        var probe = MergeProbe.ThreeWay(host, File.ReadAllBytes(baseOml), File.ReadAllBytes(foreign), merged);
        var deferred = Assert.Single(probe.Deferred!);
        Assert.Equal(("Pet.SpeciesId", "Entities.Species.Cat", "1"), (deferred.Element, deferred.Value, deferred.BaseValue));
        Assert.Empty(Differences(host, merged, foreign));
        Assert.True(host.CheckDataContract(merged, assertions)["accepted"]!.GetValue<bool>());
    }

    [Fact]
    public void AStudioWithoutTheReadOnlyRuleDefersEveryDefaultAndStillLandsTheCandidate()
    {
        // The rule is a non-public Studio method found by reflection; a Studio build without it never stops deliveries:
        // every default goes to the second merge, which keeps a default set on an element that exists.
        Assert.NotNull(MergeOrder.ReadOnlyRule);
        var (host, dir, foreign, assertions) = Apply("no-rule", Fixture, AllClasses);
        var baseBytes = File.ReadAllBytes(Fixture);
        var (deferred, firstPass) = MergePlanner.Plan(host, baseBytes, File.ReadAllBytes(foreign), rule: null);
        var named = deferred.Select(d => d.Element + " = " + d.Value).ToHashSet(StringComparer.Ordinal);
        Assert.Superset(Deferred.ToHashSet(StringComparer.Ordinal), named);
        Assert.Contains("Pet.Weight = 3", named); // a default the Studio keeps is deferred too
        Assert.NotNull(firstPass);
        var merged = Path.Combine(dir, "merged.oml");
        var probe = MergeProbe.Replay(host, baseBytes, baseBytes, File.ReadAllBytes(foreign), firstPass, merged);
        Assert.False(probe.HasConflicts);
        Assert.Empty(Differences(host, merged, foreign));
        Assert.True(host.CheckDataContract(merged, assertions)["accepted"]!.GetValue<bool>());
    }

    [Fact]
    public void ACandidateWithoutReadOnlyDefaultsKeepsOneMerge()
    {
        var (host, _, foreign, _) = Apply("no-order", Fixture,
            """{"ops":[{"op":"spec","data":{"static":[SPECIES],"entities":[{"name":"Pet","public":true,"attributes":[{"name":"SpeciesId","type":"Species Identifier"},{"name":"Weight","type":"Integer","default":"3"}]}]}}]}""");
        var (deferred, firstPass) = MergeProbe.Plan(host, File.ReadAllBytes(Fixture), File.ReadAllBytes(foreign));
        Assert.Empty(deferred);
        Assert.Null(firstPass);
    }

    internal static (ModelHost Host, string Dir, string Output, JsonArray Assertions) Apply(string name, string basePath, string job, string? dir = null)
    {
        StudioAssemblies.Bind();
        dir ??= Path.Combine(Root, ".local", "merge-order-tests", name + "-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var host = new ModelHost(dir);
        var jobPath = Path.Combine(dir, name + ".json"); File.WriteAllText(jobPath, job.Replace("SPECIES", Species));
        var output = Path.Combine(dir, name + ".oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, jobPath, output))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + " " + result["details"]?.ToJsonString());
        return (host, dir, output, result["dataContract"]!["assertions"]!.AsArray());
    }

    internal static string[] Differences(ModelHost host, string model, string expected) =>
        MergeProbe.CompareDump(host, File.ReadAllBytes(model), File.ReadAllBytes(expected)).Split('\n').Where(l => l.Contains('[')).Select(l => l.TrimEnd()).ToArray();

    private static string Short(string element) => string.Join(".", element.Split(" / ").Skip(1).Select(s => s[..s.LastIndexOf(" (", StringComparison.Ordinal)]));
}
