using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// C-27 (ported from the proto line): the contract of o11_data as the friction reports met it. A write without a UUID
/// operationId was refused with "requires a stable UUID operationId" and no example (F-FigmaMobile-10a, F-AiChatbot-06c,
/// F-FitBody-52): the refusal names the form and offers one, the same for the same write. An update needed the identifier
/// inside each record (F-FitBody-19): ids, one per record in order, as a delete takes them, is that identifier. No server.
/// </summary>
public sealed class O11DataContractTests
{
    private static DataAttribute A(string name, string type, bool autoNumber = false) => new(name, "k-" + name.ToLowerInvariant(), autoNumber, false, type);
    private static readonly DataEntity Member = new("FBMember", "e-member", false, [A("Id", "Long Integer", autoNumber: true), A("Name", "Text"), A("Steps", "Integer")]);
    private static readonly DataSchema Schema = new("FigmaMobile", "e-module", [Member]);

    private static JsonObject Request(string json) => JsonNode.Parse(json)!.AsObject();

    [Fact]
    public void AWriteWithoutAUuidOperationIdIsOfferedOneTheSameForTheSameWrite()
    {
        const string write = """{"operation":"insert","entity":"FBMember","authorization":"load the members","records":[{"Name":"Ana","Steps":10}]}""";
        var problem = Assert.Single(EnvironmentData.ValidateBatch(Schema, Request(write)))!.AsObject();
        Assert.Equal("/operationId", problem["pointer"]!.ToString());
        Assert.Contains("UUID (8-4-4-4-12 hexadecimal", problem["message"]!.ToString());
        var suggested = problem["patch"]![0]!["value"]!.ToString();
        Assert.True(Guid.TryParse(suggested, out _), suggested);
        Assert.Equal("add", problem["patch"]![0]!["op"]!.ToString());
        Assert.Contains(suggested, problem["fix"]!.ToString());
        // The same write gets the same one; another write another.
        Assert.Equal(suggested, Assert.Single(EnvironmentData.ValidateBatch(Schema, Request(write)))!["patch"]![0]!["value"]!.ToString());
        Assert.NotEqual(suggested, Assert.Single(EnvironmentData.ValidateBatch(Schema, Request(write.Replace("Ana", "Bia"))))!["patch"]![0]!["value"]!.ToString());
        // A non-UUID says so, and the patch replaces it; with the suggestion the write is valid.
        var named = Request(write.Replace("\"authorization\"", "\"operationId\":\"op-1\",\"authorization\""));
        var replaced = Assert.Single(EnvironmentData.ValidateBatch(Schema, named))!.AsObject();
        Assert.Contains("'op-1' is not one", replaced["message"]!.ToString());
        Assert.Equal("replace", replaced["patch"]![0]!["op"]!.ToString());
        named["operationId"] = replaced["patch"]![0]!["value"]!.DeepClone();
        Assert.Empty(EnvironmentData.ValidateBatch(Schema, named));
        // In a batch, each write has its own, at its own pointer.
        var batch = Request("""{"authorization":"load the members","batch":[{"operation":"insert","entity":"FBMember","records":[{"Name":"Ana"}]},{"operation":"insert","entity":"FBMember","records":[{"Name":"Ana"}]}]}""");
        var two = EnvironmentData.ValidateBatch(Schema, batch).Select(p => p!.AsObject()).ToList();
        Assert.Equal(["/batch/0/operationId", "/batch/1/operationId"], two.Select(p => p["pointer"]!.ToString()));
        Assert.NotEqual(two[0]["patch"]![0]!["value"]!.ToString(), two[1]["patch"]![0]!["value"]!.ToString());
    }

    [Fact]
    public void AnUpdateTakesItsRecordsIdsInIdsAsADeleteDoes()
    {
        var update = Request($$"""{"operation":"update","entity":"FBMember","authorization":"update the steps","operationId":"{{Guid.NewGuid()}}","ids":["7","9"],"records":[{"Steps":12},{"Steps":30}]}""");
        Assert.Empty(EnvironmentData.ValidateBatch(Schema, update));
        Assert.Equal(["7", "9"], update["records"]!.AsArray().Select(r => r!["Id"]!.ToString()));
        Assert.Null(update["ids"]);
        // One id per record, in order; without either, the refusal says both forms.
        var short1 = Request($$"""{"operation":"update","entity":"FBMember","authorization":"x","operationId":"{{Guid.NewGuid()}}","ids":["7"],"records":[{"Steps":1},{"Steps":2}]}""");
        Assert.Contains(EnvironmentData.ValidateBatch(Schema, short1), p => p!["pointer"]!.ToString() == "/ids");
        var none = Request($$"""{"operation":"update","entity":"FBMember","authorization":"x","operationId":"{{Guid.NewGuid()}}","records":[{"Steps":1}]}""");
        Assert.Contains("or ids: one id per record", Assert.Single(EnvironmentData.ValidateBatch(Schema, none))!["message"]!.ToString());
    }
}
