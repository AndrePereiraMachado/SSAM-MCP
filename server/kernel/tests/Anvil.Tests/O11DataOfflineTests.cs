using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public class O11DataOfflineTests
{
    private static readonly DataSchema Schema = new("Offline", "module", [
        new("Item", "item", false, [new("RecordId", "id", true, false, "Long Integer"), new("Quantity", "quantity", false, false, "Integer"), new("CreatedOn", "created", false, false, "DateTime"), new("Attachment", "attachment", false, true, "Binary")], [new("Quantity_Created", true, ["Quantity", "CreatedOn"])]),
        new("Category", "category", true, [new("Id", "cat-id", false, false, "Category Identifier"), new("Label", "label", false, false, "Text")])]);
    private static JsonObject Request(string json) => JsonNode.Parse(json)!.AsObject();

    [Fact]
    public void ACheckAnswersEveryProblemOfEveryOperationAndWritesNothing()
    {
        var request = Request("""{"authorization":"load the synthetic records","batch":[{"operation":"insert","entity":"Item","operationId":"10000000-0000-0000-0000-000000000001","records":[{"Quantity":"bad","CreatedOn":"not a date"}]},{"operation":"update","entity":"Item","operationId":"10000000-0000-0000-0000-000000000002","records":[{"Quantity":1.5,"CreatedOn":"2026-10-03T12:00:00Z"}]}]}""");
        var result = EnvironmentData.Check(Schema, request, true);
        Assert.False(result["ok"]!.GetValue<bool>());
        Assert.Equal(0, result["submitted"]!.GetValue<int>());
        Assert.Empty(result["results"]!.AsArray());
        var pointers = result["problems"]!.AsArray().Select(p => p!["pointer"]!.ToString()).ToArray();
        Assert.Equal(new[] { "/batch/0/records/0/Quantity", "/batch/0/records/0/CreatedOn", "/batch/1/records/0/RecordId", "/batch/1/records/0/Quantity", "/batch/1/records/0/CreatedOn" }, pointers);
    }

    [Fact]
    public void ACheckWithoutWriteFieldsIgnoresOnlyAuthorizationAndOperationId()
    {
        var valid = Request("""{"batch":[{"operation":"insert","entity":"Item","operationId":"bad","records":[{"Quantity":3}]},{"operation":"insert","entity":"Item","operationId":"bad","records":[{"Quantity":4}]}]}""");
        Assert.True(EnvironmentData.Check(Schema, valid, false)["ok"]!.GetValue<bool>());
        Assert.Equal(4, EnvironmentData.Check(Schema, valid, true)["problems"]!.AsArray().Count);
        valid["batch"]![0]!["records"]![0]!["Quantity"] = "bad";
        var result = EnvironmentData.Check(Schema, valid, false);
        Assert.False(result["ok"]!.GetValue<bool>());
        Assert.Equal("DATA_VALUE_INVALID", Assert.Single(result["problems"]!.AsArray())!["code"]!.ToString());
        var statics = EnvironmentData.Check(Schema, Request("""{"operation":"insert","entity":"Category","records":[{"Label":"A"}]}"""), false);
        Assert.False(statics["ok"]!.GetValue<bool>());
        Assert.Contains("static entity", statics["problems"]![0]!["message"]!.ToString());
        var reference = EnvironmentData.Check(Schema, Request("""{"operation":"insert","entity":"Item","records":[{"Quantity":{"$ref":"unknown"}}]}"""), false);
        Assert.Equal("DATA_REF_UNRESOLVED", Assert.Single(reference["problems"]!.AsArray())!["code"]!.ToString());
    }

    [Fact]
    public void ACheckOfAValidRequestCountsOperationsAndRecords()
    {
        var result = EnvironmentData.Check(Schema, Request("""{"batch":[{"operation":"insert","entity":"Item","records":[{"Quantity":1},{"Quantity":2}]},{"operation":"update","entity":"Item","records":[{"RecordId":"3","Quantity":4}]}]}"""), false);
        Assert.True(result["ok"]!.GetValue<bool>());
        Assert.Equal(2, result["operations"]!.GetValue<int>());
        Assert.Equal(3, result["records"]!.GetValue<int>());
    }

    [Fact]
    public void TheSchemaAnswerNamesIdentifierTypesAndStaticEntities()
    {
        var answer = EnvironmentData.SchemaAnswer(Schema);
        Assert.Equal("Offline", answer["module"]!.ToString());
        Assert.Equal("module", answer["moduleKey"]?.ToString());
        Assert.Equal("item", answer["entities"]![0]!["key"]?.ToString());
        Assert.NotNull(answer["entities"]![0]!["indexes"]);
        var uniqueIndex = Assert.Single(answer["entities"]![0]!["indexes"]!.AsArray())!;
        Assert.Equal("Quantity_Created", uniqueIndex["name"]!.ToString());
        Assert.True(uniqueIndex["unique"]!.GetValue<bool>());
        Assert.Equal(new[] { "Quantity", "CreatedOn" }, uniqueIndex["attributes"]!.AsArray().Select(a => a!.ToString()));
        var entities = answer["entities"]!.AsArray();
        Assert.Equal("RecordId", entities[0]!["identifier"]!.ToString());
        Assert.False(entities[0]!["static"]!.GetValue<bool>());
        Assert.True(entities[1]!["static"]!.GetValue<bool>());
        Assert.Equal("Category Identifier", entities[1]!["attributes"]![0]!["type"]!.ToString());
        Assert.True(entities[0]!["attributes"]![0]!["autoNumber"]!.GetValue<bool>());
        Assert.False(entities[0]!["attributes"]![0]!["binary"]!.GetValue<bool>());
        Assert.True(entities[0]!["attributes"]![3]!["binary"]!.GetValue<bool>());
    }

    [Fact]
    public void TheSchemaAnswerReadsAPublishedSnapshotWithoutAStudioSession()
    {
        if (!StudioAvailable()) return;
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(O11DataOfflineTests).Assembly.Location)!)!;
        var work = Path.Combine(Path.GetTempPath(), "o11-data-offline", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        var job = Path.Combine(work, "job.json"); var output = Path.Combine(work, "data.oml");
        File.WriteAllText(job, """{"ops":[{"op":"spec","data":{"static":[{"name":"Category","records":[{"name":"One","label":"One"}]}],"entities":[{"name":"Item","attributes":[{"name":"Quantity","type":"Integer"},{"name":"CreatedOn","type":"Date Time"},{"name":"CategoryId","type":"Category Identifier"}]}]}}]}""");
        JobRunner.Run(host, Path.Combine(root, "tests", "fixtures", "blank-service.oml"), job, output);
        var answer = EnvironmentData.SchemaAnswer(EnvironmentData.Schema(host, output));
        var entities = answer["entities"]!.AsArray();
        var item = entities.Single(e => e!["name"]!.ToString() == "Item")!;
        Assert.Equal("Id", item["identifier"]!.ToString());
        Assert.Equal("DateTime", item["attributes"]!.AsArray().Single(a => a!["name"]!.ToString() == "CreatedOn")!["type"]!.ToString());
        Assert.True(entities.Single(e => e!["name"]!.ToString() == "Category")!["static"]!.GetValue<bool>());
    }

    private static bool StudioAvailable() { try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; } }
}
