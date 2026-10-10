using System.Collections;
using System.Text.Json.Nodes;
using Anvil.Authoring;
using Anvil.Authoring.Transport;
using Xunit;

namespace Anvil.CSharp.Tests;

// Pure caller codec tests. The peer below constructs graph replies; these tests do
// not claim acceptance of compiler lowering, native entry guards or live O11 behavior.
public class ReadOnlyListSdkTests
{
    private static readonly GraphReadOnlyList View = new("Lists", "Arrays");
    private static GraphDefinition[] Definitions => [new("Lists", typeof(List<int>), [], new GraphScalar(typeof(int))),
        new("Arrays", typeof(int[]), [], new GraphScalar(typeof(int)))];

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ConcreteRootAndTwoViewsShareOneIdentityAndCallerMutation(bool array)
    {
        object original = array ? new[] { 7 } : new List<int> { 7 };
        var target = array ? "Arrays" : "Lists";
        GraphShape[] shapes = [new GraphReference(target), View, View];
        var session = new ReferenceGraphSession(Definitions, 4); var wire = new ReferenceGraphWire(Definitions, 4);
        var encoded = session.Encode(shapes, [original, original, original]);
        Assert.Single(encoded.Arenas[target]); Assert.Empty(encoded.Arenas[array ? "Lists" : "Arrays"]);
        Assert.Equal(encoded.Roots[0], encoded.Roots[1]); Assert.Equal(encoded.Roots[1], encoded.Roots[2]);
        var roots = wire.EncodeRoots(encoded, shapes); var arenas = wire.EncodeArenas(encoded);
        Assert.Equal(array ? 2 : 1, roots[1]!["Kind"]!.GetValue<int>());
        Assert.Equal(1, roots[0]!["Index"]!.GetValue<int>()); Assert.Equal(1, roots[1]!["Index"]!.GetValue<int>());
        arenas[target]![0]!["Items"]![0] = 19;
        if (!array) arenas[target]![0]!["Version"] = arenas[target]![0]!["Version"]!.GetValue<int>() + 1;
        var values = session.Reconcile(wire.Decode(arenas, roots, shapes), shapes);
        Assert.All(values, value => Assert.Same(original, value)); Assert.Equal(19, ((IReadOnlyList<int>)original)[0]);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ANewReturnedViewKeepsItsConcreteRuntimeTypeAndCanAliasAConcreteResult(bool array)
    {
        var session = new ReferenceGraphSession(Definitions, 4); var request = session.Encode([], []);
        var target = array ? "Arrays" : "Lists";
        var arenas = request.Arenas.ToDictionary(pair => pair.Key, pair => pair.Value);
        arenas[target] = [array ? new GraphSequence([3, 5]) : new GraphSequence([3, 5], 2, 8)];
        GraphShape[] shapes = [View, View, new GraphReference(target)];
        var response = new ReferenceGraph(arenas, [new GraphHandle(target, 1), new GraphHandle(target, 1), new GraphHandle(target, 1)]);
        var values = session.Reconcile(response, shapes);
        Assert.Equal(array ? typeof(int[]) : typeof(List<int>), values[0]!.GetType());
        Assert.All(values, value => Assert.Same(values[0], value));
        Assert.Equal(new[] { 3, 5 }, (IReadOnlyList<int>)values[0]!);
        if (!array) Assert.Equal(8, ((List<int>)values[0]!).Capacity);
    }

    [Fact]
    public void NullAndEmptyConcreteCollectionsHaveDistinctCanonicalHandles()
    {
        var session = new ReferenceGraphSession(Definitions, 4); var wire = new ReferenceGraphWire(Definitions, 4);
        GraphShape[] shapes = [View, View, View];
        var encoded = session.Encode(shapes, [null, new List<int>(), Array.Empty<int>()]);
        var roots = wire.EncodeRoots(encoded, shapes);
        Assert.Equal("{\"Kind\":0,\"Index\":0}", roots[0]!.ToJsonString());
        Assert.Equal("{\"Kind\":1,\"Index\":1}", roots[1]!.ToJsonString());
        Assert.Equal("{\"Kind\":2,\"Index\":1}", roots[2]!.ToJsonString());
        var values = session.Reconcile(wire.Decode(wire.EncodeArenas(encoded), roots, shapes), shapes);
        Assert.Null(values[0]); Assert.Empty(Assert.IsType<List<int>>(values[1])); Assert.Empty(Assert.IsType<int[]>(values[2]));
    }

    [Theory]
    [InlineData("{\"Kind\":0,\"Index\":1}")]
    [InlineData("{\"Kind\":1,\"Index\":0}")]
    [InlineData("{\"Kind\":2,\"Index\":0}")]
    [InlineData("{\"Kind\":-1,\"Index\":1}")]
    [InlineData("{\"Kind\":3,\"Index\":1}")]
    [InlineData("{\"Kind\":1,\"Index\":-1}")]
    [InlineData("{\"Kind\":1,\"Index\":2}")]
    [InlineData("{\"Kind\":2,\"Index\":1}")]
    [InlineData("{\"Kind\":1.5,\"Index\":1}")]
    [InlineData("{\"Kind\":1,\"Index\":1.5}")]
    [InlineData("{\"Kind\":1,\"Index\":2147483648}")]
    [InlineData("{\"Kind\":\"1\",\"Index\":1}")]
    [InlineData("{\"Kind\":1,\"Index\":null}")]
    [InlineData("{\"Kind\":1}")]
    [InlineData("{\"Kind\":1,\"Index\":1,\"Other\":0}")]
    public void MalformedOrOutOfRangeWireViewFailsBeforeCallerWriteback(string invalid)
    {
        var original = new List<int> { 7 };
        var call = new ReferenceGraphCall("Update", ["Arg_value"], [View], [View], Definitions, 4);
        Assert.Throws<InvalidDataException>(() => call.Invoke([original], (_, request) => {
            var response = Reply(request, JsonNode.Parse(invalid)!);
            response["AvGraphOut"]!["Lists"]![0]!["Items"]![0] = 99;
            return response;
        }));
        Assert.Equal(new[] { 7 }, original);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void HiddenListOrArrayIdentitiesRemainOutsideTheResultClosure(bool array)
    {
        var original = new List<int> { 7 };
        var call = new ReferenceGraphCall("Update", ["Arg_value"], [View], [View], Definitions, 4);
        Assert.Throws<InvalidDataException>(() => call.Invoke([original], (_, request) => {
            var response = Reply(request, request["Arg_value"]!);
            response["AvGraphOut"]!["Lists"]![0]!["Items"]![0] = 99;
            var target = response["AvGraphOut"]![array ? "Arrays" : "Lists"]!.AsArray();
            target.Add(array ? new JsonObject { ["Items"] = new JsonArray(123) }
                : new JsonObject { ["Items"] = new JsonArray(123), ["Version"] = 1, ["Capacity"] = 1 });
            return response;
        }));
        Assert.Equal(new[] { 7 }, original);
    }

    [Fact]
    public void UnsupportedRuntimeImplementationsFailBeforeSendingOrEnumerating()
    {
        var sent = 0;
        foreach (var value in new object[] { new CustomList(), new DangerousView() })
        {
            var call = new ReferenceGraphCall("Echo", ["Arg_value"], [View], [View], Definitions, 4);
            Assert.Throws<ArgumentException>(() => call.Invoke([value], (_, _) => { sent++; throw new Exception("transport reached"); }));
        }
        GraphDefinition[] definitions = [new("Objects", typeof(object), []),
            new("Lists", typeof(List<object>), [], new GraphReference("Objects")),
            new("Arrays", typeof(object[]), [], new GraphReference("Objects"))];
        // Both values implement IReadOnlyList<object> through covariance, but their
        // runtime element type differs from the compiler's exact canonical arenas.
        foreach (IReadOnlyList<object> value in new IReadOnlyList<object>[] { new List<string> { "x" }, new[] { "x" } })
        {
            var call = new ReferenceGraphCall("Echo", ["Arg_value"], [View], [View], definitions, 4);
            Assert.Throws<ArgumentException>(() => call.Invoke([value], (_, _) => { sent++; throw new Exception("transport reached"); }));
        }
        Assert.Equal(0, sent);
    }

    [Theory]
    [InlineData(2)]
    [InlineData(3)]
    public void EarlierAbiVersionsRejectReadonlyListShapesAndMetadata(int version)
    {
        Assert.Throws<ArgumentException>(() => new ReferenceGraphSession(Definitions, version).Encode([View], [null]));
        Assert.Throws<InvalidDataException>(() => new ReferenceGraphBinding(Schema(), typeof(ReadOnlyListSdkTests).Assembly, version));
        var downgraded = Schema(); downgraded["version"] = version;
        if (version == 2) downgraded.Remove("exceptionArena");
        Assert.Throws<InvalidDataException>(() => new ReferenceGraphBinding(downgraded, typeof(ReadOnlyListSdkTests).Assembly, 4));
    }

    [Fact]
    public void MetadataRequiresBothExactConcreteArenasAndTheSameElementType()
    {
        var binding = new ReferenceGraphBinding(Schema(), typeof(ReadOnlyListSdkTests).Assembly, 4);
        Assert.Equal(View, Assert.Single(binding.Inputs));
        var missing = Schema(); missing["definitions"]!.AsArray().RemoveAt(1);
        Assert.Throws<ArgumentException>(() => new ReferenceGraphBinding(missing, typeof(ReadOnlyListSdkTests).Assembly, 4));
        var mismatched = Schema(); mismatched["definitions"]![1]!["type"]!["element"]!["name"] = "System.Int64";
        mismatched["definitions"]![1]!["element"]!["type"]!["name"] = "System.Int64";
        Assert.Throws<ArgumentException>(() => new ReferenceGraphBinding(mismatched, typeof(ReadOnlyListSdkTests).Assembly, 4));
        var reversed = Schema(); reversed["inputs"]![0]!["shape"]!["listArena"] = "Arrays";
        reversed["inputs"]![0]!["shape"]!["arrayArena"] = "Lists";
        Assert.Throws<ArgumentException>(() => new ReferenceGraphBinding(reversed, typeof(ReadOnlyListSdkTests).Assembly, 4));
        var unknown = Schema(); unknown["inputs"]![0]!["shape"]!["extra"] = "x";
        Assert.Throws<InvalidDataException>(() => new ReferenceGraphBinding(unknown, typeof(ReadOnlyListSdkTests).Assembly, 4));
    }

    [Theory]
    [InlineData("identity", 32, 64)]
    [InlineData("identity", 64, 32)]
    [InlineData("nullable", 32, 64)]
    [InlineData("nullable", 64, 32)]
    [InlineData("inline", 32, 64)]
    [InlineData("inline", 64, 32)]
    [InlineData("nullable-inline", 32, 64)]
    [InlineData("nullable-inline", 64, 32)]
    public void MetadataRejectsUnequalIdentityWidthsWithinBackingElementShapes(string wrapper, int listBits, int arrayBits)
    {
        var error = Assert.Throws<ArgumentException>(() => new ReferenceGraphBinding(
            IdentitySchema(wrapper, listBits, arrayBits), typeof(ReadOnlyListSdkTests).Assembly, 4));
        Assert.Contains("equivalent list and array element graph shapes", error.Message);
    }

    [Theory]
    [InlineData("name")]
    [InlineData("storage")]
    [InlineData("omitted")]
    public void MetadataRejectsDifferentInlineElementMappings(string change)
    {
        var schema = IdentitySchema("inline", 64, 64);
        var fields = schema["definitions"]![1]!["element"]!["fields"]!.AsArray();
        if (change == "name") fields[0]!["name"] = "AnotherValue";
        else if (change == "omitted") fields.RemoveAt(1);
        else
        {
            fields[0]!["storage"] = "Other"; fields[0]!["sourceMember"] = "Other";
            fields[1]!["storage"] = "Value"; fields[1]!["sourceMember"] = "Value";
        }
        var error = Assert.Throws<ArgumentException>(() => new ReferenceGraphBinding(schema, typeof(ReadOnlyListSdkTests).Assembly, 4));
        Assert.Contains("equivalent list and array element graph shapes", error.Message);
    }

    [Theory]
    [InlineData(32, false)]
    [InlineData(32, true)]
    [InlineData(64, false)]
    [InlineData(64, true)]
    public void EquivalentIdentityElementsPreserveConcreteIdentityAndWidth(int bits, bool array)
    {
        var before = bits == 32 ? int.MaxValue - 1L : long.MaxValue - 1L;
        var item = new Id<IdentityTarget>(before);
        IReadOnlyList<Id<IdentityTarget>> original = array ? new[] { item } : new List<Id<IdentityTarget>> { item };
        var binding = new ReferenceGraphBinding(IdentitySchema("identity", bits, bits), typeof(ReadOnlyListSdkTests).Assembly, 4);
        var result = binding.CreateCall("Update").Invoke([original], (_, request) => {
            var reply = Reply(request, request["Arg_value"]!);
            reply["AvGraphOut"]![array ? "Arrays" : "Lists"]![0]!["Items"]![0] = before + 1;
            return reply;
        });
        Assert.Same(original, result); Assert.Equal(before + 1, original[0].Value);
    }

    [Theory]
    [InlineData("nullable")]
    [InlineData("inline")]
    [InlineData("nullable-inline")]
    public void EquivalentNestedIdentityShapesRemainValid(string wrapper)
    {
        var binding = new ReferenceGraphBinding(IdentitySchema(wrapper, 64, 64), typeof(ReadOnlyListSdkTests).Assembly, 4);
        Assert.Equal(View, Assert.Single(binding.Inputs));
    }

    [Fact]
    public void EquivalentInlineFieldMappingsCanHaveDifferentDeclarationOrder()
    {
        var schema = IdentitySchema("inline", 64, 64);
        var fields = schema["definitions"]![1]!["element"]!["fields"]!.AsArray();
        var first = fields[0]!.DeepClone(); fields[0] = fields[1]!.DeepClone(); fields[1] = first;
        var binding = new ReferenceGraphBinding(schema, typeof(ReadOnlyListSdkTests).Assembly, 4);
        var original = new[] { new InlineIdentity { Value = new(4_000_000_000L), Other = new(5_000_000_000L) } };
        var result = binding.CreateCall("Echo").Invoke([original], (_, request) => Reply(request, request["Arg_value"]!));
        Assert.Same(original, result); Assert.Equal(4_000_000_000L, original[0].Value.Value); Assert.Equal(5_000_000_000L, original[0].Other.Value);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void EquivalentElementReferencesAllowCyclesThroughReadonlyViews(bool array)
    {
        var node = new RecursiveNode();
        IReadOnlyList<RecursiveNode> original = array ? new[] { node } : new List<RecursiveNode> { node };
        node.Children = original;
        GraphDefinition[] definitions = [
            new("Nodes", typeof(RecursiveNode), [new("Children", typeof(RecursiveNode).GetField("Children")!, View)]),
            new("Lists", typeof(List<RecursiveNode>), [], new GraphReference("Nodes")),
            new("Arrays", typeof(RecursiveNode[]), [], new GraphReference("Nodes"))
        ];
        var session = new ReferenceGraphSession(definitions, 4); var wire = new ReferenceGraphWire(definitions, 4);
        GraphShape[] shapes = [View]; var graph = session.Encode(shapes, [original]);
        var result = session.Reconcile(wire.Decode(wire.EncodeArenas(graph), wire.EncodeRoots(graph, shapes), shapes), shapes);
        Assert.Same(original, Assert.Single(result)); Assert.Same(node, original[0]); Assert.Same(original, node.Children);
    }

    [Fact]
    public void ReadonlyViewFieldsAndNestedSequencesKeepTheUnderlyingIdentity()
    {
        var definitions = Definitions.Concat(new GraphDefinition[] {
            new("Holders", typeof(Holder), [new("View", typeof(Holder).GetField("View")!, View)]),
            new("NestedLists", typeof(List<IReadOnlyList<int>>), [], View),
            new("NestedArrays", typeof(IReadOnlyList<int>[]), [], View)
        }).ToArray();
        var list = new List<int> { 5 }; var holder = new Holder { View = list };
        var nested = new List<IReadOnlyList<int>> { list, list };
        var session = new ReferenceGraphSession(definitions, 4);
        GraphShape[] shapes = [new GraphReference("Holders"), new GraphReadOnlyList("NestedLists", "NestedArrays"), View];
        var graph = session.Encode(shapes, [holder, nested, list]);
        var wire = new ReferenceGraphWire(definitions, 4);
        var values = session.Reconcile(wire.Decode(wire.EncodeArenas(graph), wire.EncodeRoots(graph, shapes), shapes), shapes);
        Assert.Same(holder, values[0]); Assert.Same(nested, values[1]); Assert.Same(list, values[2]);
        Assert.Same(list, holder.View); Assert.Same(list, nested[0]); Assert.Same(nested[0], nested[1]);

        var metadata = Schema();
        foreach (var (arena, kind) in new[] { ("NestedLists", "list"), ("NestedArrays", "array") })
            metadata["definitions"]!.AsArray().Add(new JsonObject {
                ["arena"] = arena,
                ["type"] = new JsonObject { ["kind"] = kind, ["element"] = new JsonObject {
                    ["kind"] = "readonly-list", ["element"] = new JsonObject { ["kind"] = "primitive", ["name"] = "System.Int32" } } },
                ["element"] = new JsonObject { ["kind"] = "readonly-list", ["listArena"] = "Lists", ["arrayArena"] = "Arrays" }
            });
        var binding = new ReferenceGraphBinding(metadata, typeof(ReadOnlyListSdkTests).Assembly, 4);
        Assert.Equal(typeof(List<IReadOnlyList<int>>), binding.Definitions.Single(d => d.Name == "NestedLists").Type);
        Assert.Equal(typeof(IReadOnlyList<int>[]), binding.Definitions.Single(d => d.Name == "NestedArrays").Type);
    }

    [Fact]
    public void ReadonlyListShapeCannotLieAboutSourceFieldStorage()
    {
        var definitions = Definitions.Append(new GraphDefinition("Wrong", typeof(WrongHolder),
            [new("View", typeof(WrongHolder).GetField("View")!, View)]));
        Assert.Throws<ArgumentException>(() => new ReferenceGraphSession(definitions, 4));
    }

    [Fact]
    public void OptionalInlineAbsenceRejectsAnInactiveReadonlyHandle()
    {
        var shape = new GraphOptional(new GraphInline(typeof(InlineView), [new("View", typeof(InlineView).GetField("View")!, View)]));
        var call = new ReferenceGraphCall("Echo", ["Arg_value"], [shape], [shape], Definitions, 4);
        Assert.Throws<InvalidDataException>(() => call.Invoke([null], (_, request) => Reply(request,
            JsonNode.Parse("{\"HasValue\":false,\"Value\":{\"View\":{\"Kind\":1,\"Index\":1}}}")!)));
        Assert.Null(call.Invoke([null], (_, request) => Reply(request, request["Arg_value"]!)));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void FailureRequiresANullViewAndOnlyThenReconcilesBeforeThrowing(bool invalidResult)
    {
        var original = new List<int> { 7 }; var failure = new InvalidOperationException("source failure");
        var call = new ReferenceGraphCall("Fail", ["Arg_value", "Arg_failure"],
            [View, new GraphException(typeof(Exception))], [View], Definitions, 4);
        object? Invoke() => call.Invoke([original, failure], (_, request) => {
            var response = Reply(request, invalidResult ? request["Arg_value"]!
                : new JsonObject { ["Kind"] = 0, ["Index"] = 0 });
            response["AvCompletion"]!["Kind"] = 2; response["AvCompletion"]!["ExceptionRef"] = 1;
            response["AvGraphOut"]!["Lists"]![0]!["Items"]![0] = 99;
            return response;
        });
        if (invalidResult)
        {
            Assert.Throws<InvalidDataException>(Invoke); Assert.Equal(new[] { 7 }, original);
        }
        else
        {
            Assert.Same(failure, Assert.Throws<InvalidOperationException>(Invoke)); Assert.Equal(new[] { 99 }, original);
        }
    }

    private static JsonObject Reply(JsonObject request, JsonNode result) => new() {
        ["AvGraphAbiOut"] = 4, ["AvGraphOut"] = request["AvGraphIn"]!.DeepClone(),
        ["AvCompletion"] = new JsonObject { ["Kind"] = 1, ["ExceptionRef"] = 0 }, ["AvResult"] = result.DeepClone()
    };

    private static JsonObject Schema() => JsonNode.Parse("""
        {"id":"anvil.csharp.reference-graph","version":4,"exceptionArena":"Exceptions",
         "inputs":[{"name":"Arg_value","sourceName":"value","shape":{"kind":"readonly-list","listArena":"Lists","arrayArena":"Arrays"}}],
         "results":[{"kind":"readonly-list","listArena":"Lists","arrayArena":"Arrays"}],
         "definitions":[
          {"arena":"Lists","type":{"kind":"list","element":{"kind":"primitive","name":"System.Int32"}},"element":{"kind":"scalar","type":{"kind":"primitive","name":"System.Int32"}}},
          {"arena":"Arrays","type":{"kind":"array","element":{"kind":"primitive","name":"System.Int32"}},"element":{"kind":"scalar","type":{"kind":"primitive","name":"System.Int32"}}}
         ]}
        """)!.AsObject();

    private static JsonObject IdentitySchema(string wrapper, int listBits, int arrayBits)
    {
        static JsonObject SourceType(Type type) => new() { ["kind"] = "source", ["name"] = type.FullName };
        static JsonObject IdentityType() => new() { ["kind"] = "identity", ["target"] = SourceType(typeof(IdentityTarget)) };
        static JsonObject IdentityShape(int bits) => new() { ["kind"] = "identity", ["type"] = IdentityType(), ["bits"] = bits };
        static JsonObject InlineShape(int bits) => new() {
            ["kind"] = "inline", ["type"] = SourceType(typeof(InlineIdentity)),
            ["fields"] = new JsonArray(new[] { "Value", "Other" }.Select(name => (JsonNode)new JsonObject {
                ["name"] = name, ["sourceMember"] = name, ["storage"] = name, ["shape"] = IdentityShape(bits)
            }).ToArray())
        };
        var schema = Schema();
        for (var index = 0; index < 2; index++)
        {
            var bits = index == 0 ? listBits : arrayBits;
            var inline = wrapper.Contains("inline", StringComparison.Ordinal);
            JsonObject type = inline ? SourceType(typeof(InlineIdentity)) : IdentityType();
            JsonObject shape = inline ? InlineShape(bits) : IdentityShape(bits);
            if (wrapper.StartsWith("nullable", StringComparison.Ordinal))
            {
                type = new JsonObject { ["kind"] = "nullable", ["element"] = type };
                shape = new JsonObject { ["kind"] = "nullable", ["value"] = shape };
            }
            schema["definitions"]![index]!["type"]!["element"] = type;
            schema["definitions"]![index]!["element"] = shape;
        }
        return schema;
    }

    public sealed class IdentityTarget;
    public struct InlineIdentity { public Id<IdentityTarget> Value; public Id<IdentityTarget> Other; }
    public sealed class RecursiveNode { public IReadOnlyList<RecursiveNode>? Children; }
    public sealed class Holder { public IReadOnlyList<int>? View; }
    public sealed class WrongHolder { public List<int>? View; }
    public struct InlineView { public IReadOnlyList<int>? View; }
    private sealed class CustomList : List<int>;
    private sealed class DangerousView : IReadOnlyList<int>
    {
        public int Count => throw new Exception("count accessed");
        public int this[int index] => throw new Exception("indexer accessed");
        public IEnumerator<int> GetEnumerator() => throw new Exception("enumerator accessed");
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }
}
