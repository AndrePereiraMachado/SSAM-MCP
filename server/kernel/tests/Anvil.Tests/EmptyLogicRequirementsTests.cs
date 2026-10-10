using System.Collections;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public sealed class EmptyLogicRequirementsTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void EmptyActionsAndQueriesPreserveProofShapeTypesAndModel(bool explicitEmptyQueries)
    {
        var (host, _, fixture) = Setup("blank-service");
        var originalHash = Hash(fixture);
        var module = Load(host, fixture);
        try
        {
            var session = (ModelSession)Activator.CreateInstance(typeof(ModelSession), [module])!;
            var before = session.Dump(session.Resolve("@espace"), 1);
            var expectedTypes = JsonNode.Parse("""{"existing":{"kind":"primitive","name":"Integer"}}""")!.AsObject();
            var queries = explicitEmptyQueries ? Queries() : null;
            var proof = Check(session, expectedTypes, queries);
            Assert.True(proof["accepted"]!.GetValue<bool>());
            Assert.Equal(0, proof["count"]!.GetValue<int>());
            foreach (var name in new[] { "assertions", "differences", "actionSummary" }) Assert.Empty(proof[name]!.AsArray());
            Assert.Equal(new[] { "accepted", "actionSummary", "assertions", "count", "differences", "expectedTypes", "scope" },
                proof.Select(p => p.Key).Order(StringComparer.Ordinal));
            Assert.Equal("Declared action signatures, expressions, call targets and complete control-flow graph; not arbitrary business intent or remote runtime behavior.",
                proof["scope"]!.ToString());
            Assert.True(JsonNode.DeepEquals(expectedTypes, proof["expectedTypes"]));
            Assert.NotSame(expectedTypes, proof["expectedTypes"]);
            proof["expectedTypes"]!["existing"]!["name"] = "Text";
            Assert.Equal("Integer", expectedTypes["existing"]!["name"]!.ToString());
            if (queries != null) Assert.Equal(1, Assert.IsType<int>(ModelHost.Prop(queries, "EnumerationCount")));
            Assert.True(JsonNode.DeepEquals(before, session.Dump(session.Resolve("@espace"), 1)));
        }
        finally { Release(module); }
        Assert.Equal(originalHash, Hash(fixture));
    }

    [Fact]
    public void ScreenQueriesWithoutActionsStillCheckSourceFiltersAndTypes()
    {
        var (host, work, fixture) = Setup("reactive-ui");
        var originalHash = Hash(fixture);
        var contract = QueryContract();
        Assert.Empty(ModuleSpecification.Logic(contract)["actions"]!.AsArray());
        var output = Apply(fixture, host.PlanModuleSpecification(fixture, contract), "created");
        var proof = host.CheckModuleSpecification(output, contract);
        Assert.True(proof["accepted"]!.GetValue<bool>(), proof.ToJsonString());
        Assert.Empty(proof["actionSummary"]!.AsArray());

        // Read the real native aggregate, then pass a one-use enumerable through the public checker.
        // A query-only call must not take the empty-proof shortcut or enumerate its input twice.
        var module = Load(host, output);
        try
        {
            var session = (ModelSession)Activator.CreateInstance(typeof(ModelSession), [module])!;
            var query = contract["screens"]![0]!["queries"]![0]!.DeepClone().AsObject();
            var queries = Queries((session.Resolve("IMobileScreen:QueryOnly/ReadNotes"), query, "screen/QueryOnly/query/ReadNotes"));
            var queryProof = Check(session, new JsonObject(), queries);
            Assert.True(queryProof["accepted"]!.GetValue<bool>(), queryProof.ToJsonString());
            Assert.True(queryProof["count"]!.GetValue<int>() > 0);
            Assert.Equal(1, Assert.IsType<int>(ModelHost.Prop(queries, "EnumerationCount")));
            var source = Assert.Single(queryProof["assertions"]!.AsArray(),
                a => a!["element"]!.ToString() == "screen/QueryOnly/query/ReadNotes/source/Note" && a["property"]!.ToString() == "Source");
            Assert.Equal(session.Get(session.Resolve("IServerEntity:Note"))["key"]!.ToString(), source!["expected"]!.ToString());
        }
        finally { Release(module); }

        var mutations = new[]
        {
            (Name: "source", Element: "screen/QueryOnly/query/ReadNotes/source/Note", Property: "Source",
                Ops: new JsonArray(
                    Set("IMobileScreen:QueryOnly/ReadNotes/**IAliasedSource", "Source", "IServerEntity:Other"),
                    Set("IMobileScreen:QueryOnly/ReadNotes/**IAliasedSource", "Name", "Note"),
                    Set("IMobileScreen:QueryOnly/ReadNotes/**IFilter", "Condition", "Note.Title <> \"\""))),
            (Name: "filter", Element: "screen/QueryOnly/query/ReadNotes", Property: "filters",
                Ops: new JsonArray(Set("IMobileScreen:QueryOnly/ReadNotes/**IFilter", "Condition", "Note.Title = \"changed\""))),
            (Name: "type", Element: "screen/QueryOnly/vars/Marker", Property: "DataType",
                Ops: new JsonArray(Set("IMobileScreen:QueryOnly/Marker", "DataType", "Text")))
        };
        foreach (var mutation in mutations)
        {
            var changed = Apply(output, mutation.Ops, mutation.Name);
            var rejected = host.CheckModuleSpecification(changed, contract, proof["expectedTypes"]!.AsObject());
            File.WriteAllText(Path.Combine(work, mutation.Name + "-proof.json"), rejected.ToJsonString());
            Assert.False(rejected["accepted"]!.GetValue<bool>(), rejected.ToJsonString());
            Assert.Contains(rejected["differences"]!.AsArray(),
                d => d!["element"]!.ToString() == mutation.Element && d["property"]!.ToString() == mutation.Property);
        }
        Assert.Equal(originalHash, Hash(fixture));

        string Apply(string basis, JsonArray ops, string name)
        {
            var job = Path.Combine(work, name + ".json"); var resultPath = Path.Combine(work, name + ".oml");
            File.WriteAllText(job, new JsonObject { ["ops"] = ops }.ToJsonString());
            var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, job, resultPath))!.AsObject();
            File.WriteAllText(Path.Combine(work, name + "-result.json"), result.ToJsonString());
            Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
            return resultPath;
        }
    }

    [Theory]
    [InlineData("empty-module", "cannot be empty")]
    [InlineData("screen-field", "Unexpected")]
    [InlineData("query-field", "Unexpected")]
    public void EmptyActionsDoNotBypassModuleScreenOrQuerySchema(string fault, string message)
    {
        var contract = QueryContract();
        if (fault == "empty-module") contract = JsonNode.Parse("""{"logic":{"actions":[]}}""")!.AsObject();
        if (fault == "screen-field") contract["screens"]![0]!["Unexpected"] = true;
        if (fault == "query-field") contract["screens"]![0]!["queries"]![0]!["Unexpected"] = true;
        var error = Assert.ThrowsAny<Exception>(() => ModuleSpecification.Validate(contract));
        Assert.Contains(message, error.Message);
    }

    [Fact]
    public void PublicActionsStillRequireAndCompileAuthentication()
    {
        var contract = QueryContract();
        var action = JsonNode.Parse("""{"name":"PublicProbe","public":true,"steps":[]}""")!.AsObject();
        contract["logic"]!["actions"]!.AsArray().Add(action);
        Assert.Contains("requires an explicit access contract", Assert.Throws<ArgumentException>(() => ModuleSpecification.Validate(contract)).Message);
        action["access"] = new JsonObject { ["authenticated"] = true };
        ModuleSpecification.Validate(contract);
        var compiled = ModuleSpecification.Logic(contract);
        Assert.Equal("GetUserId() = NullIdentifier()", compiled["actions"]![0]!["steps"]![0]!["if"]!.ToString());
    }

    private static JsonObject QueryContract() => JsonNode.Parse("""
        {
          "data":{"entities":[
            {"name":"Note","attributes":[{"name":"Title","type":"Text","length":100}]},
            {"name":"Other","attributes":[{"name":"Title","type":"Text","length":100}]}
          ]},
          "logic":{"actions":[]},
          "screens":[{
            "name":"QueryOnly","type":"IMobileScreen","flow":"MainFlow","roles":["Registered"],
            "vars":[{"name":"Marker","type":"Integer"}],
            "queries":[{"get":"Note","as":"ReadNotes","where":"Note.Title <> \"\"","max":5,"start":0}],
            "widgets":[
              {"name":"Count","type":"IExpression","properties":{"Value":"ReadNotes.List.Length"}},
              {"name":"MarkerValue","type":"IExpression","properties":{"Value":"Marker"}}
            ]
          }]
        }
        """)!.AsObject();

    private static JsonObject Set(string target, string property, string value)
        => new() { ["op"] = "set", ["target"] = target, ["prop"] = property, ["value"] = value };

    private static JsonObject Check(ModelSession session, JsonObject expectedTypes, object? queries)
        => (JsonObject)typeof(ModelSession).GetMethod("CheckLogicSpecification")!
            .Invoke(session, [new JsonObject { ["actions"] = new JsonArray() }, expectedTypes, queries])!;

    private static object Queries(params (object Node, JsonObject Query, string Path)[] queries)
    {
        var element = typeof(ModelSession).GetMethod("CheckLogicSpecification")!.GetParameters()[2].ParameterType.GetGenericArguments()[0];
        var values = Array.CreateInstance(element, queries.Length);
        for (var i = 0; i < queries.Length; i++)
            values.SetValue(Activator.CreateInstance(element, [queries[i].Node, queries[i].Query, queries[i].Path]), i);
        return Activator.CreateInstance(typeof(OnceEnumerable<>).MakeGenericType(element), [values])!;
    }

    public sealed class OnceEnumerable<T>(IEnumerable<T> values) : IEnumerable<T>
    {
        public int EnumerationCount { get; private set; }
        public IEnumerator<T> GetEnumerator()
        {
            if (++EnumerationCount != 1) throw new InvalidOperationException("Queries were enumerated more than once.");
            return values.GetEnumerator();
        }
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    private static (ModelHost Host, string Work, string Fixture) Setup(string fixture)
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(EmptyLogicRequirementsTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local/empty-logic-requirements", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        return (new ModelHost(work), work, Path.Combine(root, "tests/fixtures", fixture + ".oml"));
    }
    private static object Load(ModelHost host, string path)
        => typeof(ModelHost).GetMethod("Load", [typeof(string)])!.Invoke(host, [path])!;
    private static void Release(object module) => typeof(ModelHost).GetMethod("Release")!.Invoke(null, [module]);
    private static string Hash(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)));
}
