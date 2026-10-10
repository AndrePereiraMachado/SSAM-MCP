using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public class EntityDataTests
{
    [Fact]
    public void Snapshot_distinguishes_persistent_from_static_native_entities()
    {
        StudioAssemblies.Bind();
        var root = Directory.GetCurrentDirectory();
        while (!File.Exists(Path.Combine(root, "tests/fixtures/blank-service.oml")))
            root = Directory.GetParent(root)?.FullName ?? throw new Exception("fixture root missing");
        var work = Work(); Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        var job = Path.Combine(work, "job.json"); var output = Path.Combine(work, "data.oml");
        File.WriteAllText(job, """{"ops":[{"op":"spec","data":{"static":[{"name":"Category","records":[{"name":"One","label":"One"}]}],"entities":[{"name":"Item","attributes":[{"name":"CategoryId","type":"Category Identifier"}]}]}}]}""");
        JobRunner.Run(host, Path.Combine(root, "tests/fixtures/blank-service.oml"), job, output);
        var schema = EntityData.Schema(host, output);
        Assert.False(schema.Entities.Single(e => e.Name == "Item").IsStatic);
        Assert.True(schema.Entities.Single(e => e.Name == "Category").IsStatic);
        Assert.True(schema.Entities.Single(e => e.Name == "Item").Attributes.Single(a => a.Name == "Id").AutoNumber);
    }

    [Fact]
    public void Invalid_writes_fail_preflight_before_a_receipt_is_started()
    {
        var entity = new DataEntity("Item", "key", false,
            [new("Id", "id", true, false), new("ParentId", "fk", false, false), new("Image", "img", false, true)]);
        void Check(string json) => EntityData.ValidateWrite(entity, JsonNode.Parse(json)!.AsObject());
        Check("""{"operation":"insert","records":[{"ParentId":"9007199254740993"}]}""");
        Assert.Throws<ArgumentException>(() => Check("""{"operation":"insert","records":[{"Id":"1"}]}"""));
        Assert.Throws<ArgumentException>(() => Check("""{"operation":"insert","records":[{"Unknown":"x"}]}"""));
        Assert.Throws<ArgumentException>(() => Check("""{"operation":"update","records":[{"ParentId":"1"}]}"""));
        Assert.Throws<ArgumentException>(() => Check("""{"operation":"delete","ids":[]}"""));
        Assert.Throws<ArgumentException>(() => Check("""{"operation":"binary","attribute":"ParentId","recordId":"1","base64":"AA=="}"""));
        Assert.Throws<InvalidOperationException>(() => EntityData.ValidateWrite(entity with { IsStatic = true }, JsonNode.Parse("""{"operation":"delete","ids":["1"]}""")!.AsObject()));
    }

    [Fact]
    public void Native_database_keys_are_used_instead_of_model_base64()
    {
        StudioAssemblies.Bind();
        Assert.Equal("954c3817-f8b9-4151-be78-5e889b8436ee", Keys.ToDb("FzhMlbn4UUG+eF6Im4Q27g"));
        Assert.Equal("12fb14ff-12ee-4e60-8a68-f6cb9b2d1ec0", Keys.ToDb("_xT7Eu4SYE6KaPbLmy0ewA"));
    }

    private static JsonObject Request() => new() { ["operationId"] = Guid.NewGuid().ToString(),
        ["operation"] = "insert", ["authorization"] = "Insira os dados de demonstração.", ["records"] = new JsonArray() };
    private static string Work() => Path.Combine(Path.GetTempPath(), "anvil-data-tests", Guid.NewGuid().ToString("N"));

    [Fact]
    public void Receipt_replays_success_and_partial_failure_without_sending_again()
    {
        foreach (var success in new[] { true, false })
        {
            var dir = Work(); var request = Request(); var calls = 0;
            JsonObject Send() { calls++; return new() { ["ok"] = success, ["recordId"] = "9007199254740993" }; }
            var first = DataReceipt.Execute(dir, "host", "module", "entity", "hash", request, Send);
            var second = DataReceipt.Execute(dir, "host", "module", "entity", "hash", request, Send);
            Assert.Equal(1, calls); Assert.True(second["replayed"]!.GetValue<bool>());
            Assert.Equal(success, second["ok"]!.GetValue<bool>());
            Assert.Equal("9007199254740993", second["recordId"]!.ToString());
        }
    }

    [Fact]
    public void Timeout_leaves_pending_and_blocks_resubmission()
    {
        var dir = Work(); var request = Request(); var calls = 0;
        Assert.Throws<TimeoutException>(() => DataReceipt.Execute(dir, "host", "m", "e", "h", request,
            () => { calls++; throw new TimeoutException(); }));
        var ex = Assert.Throws<InvalidOperationException>(() => DataReceipt.Execute(dir, "host", "m", "e", "h", request,
            () => { calls++; return new() { ["ok"] = true }; }));
        Assert.Contains("Uncertain", ex.Message); Assert.Equal(1, calls);
    }

    [Fact]
    public void Authorization_and_request_identity_are_checked_before_sending()
    {
        var dir = Work(); var request = Request(); request.Remove("authorization");
        Assert.Throws<ArgumentException>(() => DataReceipt.Execute(dir, "host", "m", "e", "h", request, () => throw new Exception("sent")));
        request = Request();
        DataReceipt.Execute(dir, "host", "m", "e", "h", request, () => new() { ["ok"] = true });
        Assert.Throws<InvalidOperationException>(() => DataReceipt.Execute(dir, "other-host", "m", "e", "h", request, () => throw new Exception("sent")));
    }
}
