using Anvil.Authoring.Transport;
using System.Text.Json.Nodes;
using Xunit;

namespace Anvil.CSharp.Tests;

public class ReferenceGraphWireTests
{
    [Fact]
    public void JsonWireKeepsNullEmptyUnicodeAndInt64Distinct()
    {
        GraphShape[] shapes = [new GraphScalar(typeof(string)), new GraphScalar(typeof(string)),
            new GraphScalar(typeof(string)), new GraphScalar(typeof(long))];
        var session = new ReferenceGraphSession([]); var wire = new ReferenceGraphWire([]);
        var graph = session.Encode(shapes, [null, "", "é😀", long.MaxValue]);
        var roots = wire.EncodeRoots(graph, shapes).Select(value => JsonNode.Parse(value!.ToJsonString())).ToArray();
        var result = session.Reconcile(wire.Decode(wire.EncodeArenas(graph), roots, shapes), shapes);
        Assert.Null(result[0]); Assert.Equal("", result[1]); Assert.Equal("é😀", result[2]); Assert.Equal(long.MaxValue, result[3]);
        Assert.False(roots[0]!["HasValue"]!.GetValue<bool>()); Assert.True(roots[1]!["HasValue"]!.GetValue<bool>());
    }

    [Fact]
    public void NativeTextPresenceRecordsRejectUnknownFields()
    {
        var wire = new ReferenceGraphWire([]);
        var invalidText = new JsonObject { ["HasValue"] = true, ["Value"] = "test", ["Unexpected"] = 1 };
        Assert.Throws<InvalidDataException>(() => wire.Decode(new JsonObject(), [invalidText], [new GraphScalar(typeof(string))]));
        invalidText.Remove("Unexpected"); invalidText.Remove("HasValue");
        Assert.Throws<InvalidDataException>(() => wire.Decode(new JsonObject(), [invalidText], [new GraphScalar(typeof(string))]));
    }
}
