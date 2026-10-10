using Anvil.Authoring.Transport;
using System.Text.Json.Nodes;
using Xunit;

namespace Anvil.CSharp.Tests;

public class ExceptionGraphBindingTests
{
    private static JsonObject Schema() => JsonNode.Parse("""
        {"id":"anvil.csharp.reference-graph","version":3,"exceptionArena":"Exceptions",
         "inputs":[{"name":"Arg_error","sourceName":"error","shape":{"kind":"exception","type":{"kind":"exception","name":"System.Exception"}}}],
         "results":[{"kind":"exception","type":{"kind":"exception","name":"System.Exception"}}],"definitions":[]}
        """)!.AsObject();

    [Fact]
    public void Abi3RequiresExplicitCallerNegotiationAndPreservesInputResultIdentity()
    {
        var schema = Schema();
        Assert.Throws<InvalidDataException>(() => new ReferenceGraphBinding(schema, GetType().Assembly));
        var binding = new ReferenceGraphBinding(schema, GetType().Assembly, maxSupportedVersion: 3);
        Assert.Equal(3, binding.AbiVersion);
        Assert.Equal(typeof(Exception), Assert.IsType<GraphException>(Assert.Single(binding.Inputs)).Type);
        var original = new ArgumentNullException("p", "missing");
        var result = binding.CreateCall("Echo").Invoke([original], (action, request) => {
            Assert.Equal("Echo", action); Assert.Equal(3, request["AvGraphAbiIn"]!.GetValue<int>());
            return new JsonObject { ["AvGraphAbiOut"] = 3, ["AvGraphOut"] = request["AvGraphIn"]!.DeepClone(),
                ["AvCompletion"] = new JsonObject { ["Kind"] = 1, ["ExceptionRef"] = 0 }, ["AvResult"] = request["Arg_error"]!.DeepClone() };
        });
        Assert.Same(original, result);
    }

    [Theory]
    [InlineData("version2withShape")]
    [InlineData("version2withArena")]
    [InlineData("unknownType")]
    [InlineData("customType")]
    [InlineData("sourceTypeDescriptor")]
    [InlineData("unknownShapeField")]
    [InlineData("unknownMetadata")]
    [InlineData("wrongArena")]
    [InlineData("missingArena")]
    public void FrozenSchemaRejectsUnexpectedMetadata(string invalid)
    {
        var schema = Schema(); var shape = schema["inputs"]![0]!["shape"]!.AsObject();
        switch (invalid) {
            case "version2withShape": schema["version"] = 2; schema.Remove("exceptionArena"); break;
            case "version2withArena": schema["version"] = 2; break;
            case "unknownType": shape["type"]!["name"] = "System.IO.IOException"; break;
            case "customType": shape["type"]!["name"] = typeof(CustomException).FullName; break;
            case "sourceTypeDescriptor": shape["type"]!["kind"] = "source"; break;
            case "unknownShapeField": shape["program"] = "never executable"; break;
            case "unknownMetadata": schema["program"] = "never executable"; break;
            case "wrongArena": schema["exceptionArena"] = "AvErrors"; break;
            case "missingArena": schema.Remove("exceptionArena"); break;
        }
        Assert.Throws<InvalidDataException>(() => new ReferenceGraphBinding(schema, GetType().Assembly, maxSupportedVersion: 3));
    }

    [Fact]
    public void Abi2MetadataAndPeerMessagesRemainVersion2WhenCallerSupports3()
    {
        var schema = JsonNode.Parse("""
            {"id":"anvil.csharp.reference-graph","version":2,"inputs":[],
             "results":[{"kind":"scalar","type":{"kind":"primitive","name":"System.Int32"}}],"definitions":[]}
            """)!.AsObject();
        var old = new ReferenceGraphBinding(schema, GetType().Assembly);
        var supported = new ReferenceGraphBinding(schema, GetType().Assembly, maxSupportedVersion: 3);
        Assert.Equal(2, old.AbiVersion); Assert.Equal(2, supported.AbiVersion);
        var result = supported.CreateCall("Value").Invoke([], (_, request) => {
            Assert.Single(request); Assert.Equal("AvGraphIn", request.Single().Key);
            return JsonNode.Parse("""{"AvGraphOut":{},"AvCompletion":{"Kind":1},"AvResult":7}""")!.AsObject();
        });
        Assert.Equal(7, result);
    }

    [Fact]
    public void DirectAbi2CodecRejectsExceptionShapesAndArena()
    {
        var shape = new GraphException(typeof(Exception));
        Assert.Throws<ArgumentException>(() => new ReferenceGraphSession([]).Encode([shape], [new Exception()]));
        Assert.Throws<ArgumentException>(() => new ReferenceGraphWire([]).Decode(new(), [new JsonObject { ["Index"] = 0 }], [shape]));
        Assert.Throws<InvalidDataException>(() => new ReferenceGraphWire([]).Decode(new() { ["Exceptions"] = new JsonArray() }, [], []));
    }

    [Fact]
    public void Abi3DoesNotAcceptReflectedExceptionFieldsOrReservedArenaDefinitions()
    {
        Assert.Throws<ArgumentException>(() => new ReferenceGraphSession([new("Exceptions", typeof(Poco), [])], 3));
        Assert.Throws<ArgumentException>(() => new ReferenceGraphSession([new("Error", typeof(Exception), [])], 3));
        Assert.Throws<ArgumentException>(() => new ReferenceGraphSession([new("Error", typeof(CustomException), [])], 3));
    }

    [Fact]
    public void Abi3RejectsInactiveNullablePayloadBeforeCallerWritebackWhileAbi2IsUnchanged()
    {
        var field = new GraphField("Value", typeof(Poco).GetField("Value")!, new GraphScalar(typeof(int)));
        var definitions = new GraphDefinition[] { new("State", typeof(Poco), [field]) };
        var state = new Poco { Value = 5 }; var reference = new GraphReference("State"); var nullable = new GraphOptional(new GraphScalar(typeof(int)));
        var call = new ReferenceGraphCall("Test", ["State"], [reference], [nullable], definitions, 3);
        Assert.Throws<InvalidDataException>(() => call.Invoke([state], (_, _) => JsonNode.Parse("""
            {"AvGraphAbiOut":3,"AvGraphOut":{"State":[{"Value":99}],"Exceptions":[]},
             "AvCompletion":{"Kind":1,"ExceptionRef":0},"AvResult":{"HasValue":false,"Value":87}}
            """)!.AsObject()));
        Assert.Equal(5, state.Value);
        var old = new ReferenceGraphWire([]).Decode(new(), [JsonNode.Parse("""{"HasValue":false,"Value":87}""")], [nullable]);
        Assert.Null(old.Roots[0]);
    }

    [Fact]
    public void ExceptionTypeDescriptorsWorkInListAndArrayStorageWithoutLoadingAssemblies()
    {
        var schema = Schema();
        schema["definitions"] = JsonNode.Parse("""
            [{"arena":"Errors","type":{"kind":"list","element":{"kind":"exception","name":"System.Exception"}},
              "element":{"kind":"exception","type":{"kind":"exception","name":"System.Exception"}}},
             {"arena":"ErrorArray","type":{"kind":"array","element":{"kind":"exception","name":"System.ArgumentException"}},
              "element":{"kind":"exception","type":{"kind":"exception","name":"System.ArgumentException"}}}]
            """);
        var binding = new ReferenceGraphBinding(schema, GetType().Assembly, maxSupportedVersion: 3);
        Assert.Equal(typeof(List<Exception>), binding.Definitions[0].Type);
        Assert.Equal(typeof(ArgumentException[]), binding.Definitions[1].Type);
        var graph = binding.CreateSession().Encode(binding.Inputs, [null]);
        Assert.Equal(3, binding.CreateWire().EncodeArenas(graph).Count);
    }

    public sealed class CustomException : Exception;
    public sealed class Poco { public int Value; }
}
