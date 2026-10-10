using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Authoring;
using Anvil.Authoring.Transport;
using Xunit;

namespace Anvil.CSharp.Tests;

public sealed class ReferenceIdentityTests
{
    [Theory]
    [InlineData(long.MinValue)]
    [InlineData(long.MaxValue)]
    [InlineData(9007199254740993L)]
    [InlineData(-9007199254740993L)]
    [InlineData(-1L)]
    [InlineData(0L)]
    public void IdentityRoundtripsAsExactSignedIntegerScalar(long value)
    {
        var shape = new GraphIdentity(typeof(Id<Wide>), 64);
        var session = new ReferenceGraphSession([]);
        var graph = session.Encode([shape], [new Id<Wide>(value)]);
        var wire = new ReferenceGraphWire([]);
        var json = Assert.Single(wire.EncodeRoots(graph, [shape]));
        Assert.IsAssignableFrom<JsonValue>(json);
        Assert.Equal(value.ToString(System.Globalization.CultureInfo.InvariantCulture), json!.ToJsonString());
        var decoded = wire.Decode(new(), [JsonNode.Parse(json.ToJsonString())], [shape]);
        Assert.Equal(new Id<Wide>(value), Assert.IsType<Id<Wide>>(Assert.Single(session.Reconcile(decoded, [shape]))));
    }

    [Fact]
    public void NullableAbsenceAndPresentZeroHaveDifferentWireValues()
    {
        var shape = new GraphOptional(new GraphIdentity(typeof(Id<Wide>), 64));
        var session = new ReferenceGraphSession([]);
        var graph = session.Encode([shape, shape], [null, new Id<Wide>(0)]);
        var wire = new ReferenceGraphWire([]);
        var roots = wire.EncodeRoots(graph, [shape, shape]);
        Assert.False(roots[0]!["HasValue"]!.GetValue<bool>());
        Assert.True(roots[1]!["HasValue"]!.GetValue<bool>());
        Assert.Equal(0L, roots[0]!["Value"]!.GetValue<long>());
        Assert.Equal(0L, roots[1]!["Value"]!.GetValue<long>());
        var decoded = wire.Decode(new(), roots.Select(root => JsonNode.Parse(root!.ToJsonString())).ToArray(), [shape, shape]);
        var values = session.Reconcile(decoded, [shape, shape]);
        Assert.Null(values[0]);
        Assert.Equal(default, Assert.IsType<Id<Wide>>(values[1]));
    }

    [Theory]
    [InlineData(int.MinValue)]
    [InlineData(int.MaxValue)]
    [InlineData(0)]
    public void NativeInt32IdentityStillReconstructsTheLongBackedSdkType(int value)
    {
        var shape = new GraphIdentity(typeof(Id<Narrow>), 32);
        var session = new ReferenceGraphSession([]);
        var graph = session.Encode([shape], [new Id<Narrow>(value)]);
        var wire = new ReferenceGraphWire([]);
        var roots = wire.EncodeRoots(graph, [shape]);
        Assert.Equal(new Id<Narrow>(value), Assert.Single(session.Reconcile(wire.Decode(new(), roots, [shape]), [shape])));
    }

    [Theory]
    [InlineData(-2147483649L)]
    [InlineData(2147483648L)]
    public void NativeInt32OverflowIsRejectedBeforeCallingTransport(long value)
    {
        var shape = new GraphIdentity(typeof(Id<Narrow>), 32);
        var call = new ReferenceGraphCall("Echo", ["Arg_id"], [shape], [shape], []);
        var invoked = false;
        Assert.Throws<InvalidDataException>(() => call.Invoke([new Id<Narrow>(value)], (_, _) => { invoked = true; return new(); }));
        Assert.False(invoked);
        Assert.Throws<InvalidDataException>(() => new ReferenceGraphWire([]).Decode(new(), [JsonValue.Create(value)], [shape]));
    }

    [Theory]
    [InlineData("9223372036854775808")]
    [InlineData("-9223372036854775809")]
    [InlineData("1.5")]
    [InlineData("\"123\"")]
    [InlineData("true")]
    [InlineData("null")]
    [InlineData("{\"Value\":123}")]
    public void MalformedIdentityRepliesNeverBecomeRecordsOrRoundedScalars(string json)
    {
        var shape = new GraphIdentity(typeof(Id<Wide>), 64);
        Assert.Throws<InvalidDataException>(() => new ReferenceGraphWire([]).Decode(new(), [JsonNode.Parse(json)], [shape]));
    }

    [Fact]
    public void IdentityShapesRequireExactSdkAndEntityTypes()
    {
        var shape = new GraphIdentity(typeof(Id<Wide>), 64);
        Assert.Throws<InvalidDataException>(() => new ReferenceGraphSession([]).Encode([shape], [new Id<Narrow>(1)]));
        Assert.Throws<InvalidDataException>(() => new ReferenceGraphSession([]).Encode([shape], [1L]));
        Assert.Throws<ArgumentException>(() => new ReferenceGraphSession([]).Encode([new GraphIdentity(typeof(Impostor), 64)], [default(Impostor)]));
        Assert.Throws<ArgumentException>(() => new ReferenceGraphSession([]).Encode([new GraphIdentity(typeof(GenericImpostor<Wide>), 64)], [default(GenericImpostor<Wide>)]));
        Assert.Throws<ArgumentException>(() => new ReferenceGraphSession([]).Encode([new GraphIdentity(typeof(Id<>), 64)], [null]));
        Assert.Throws<ArgumentException>(() => new ReferenceGraphSession([]).Encode([new GraphIdentity(typeof(Id<Wide>), 16)], [new Id<Wide>(1)]));
    }

    [Fact]
    public void CompilerDescriptorsFollowNativeEntityKeyStorageAndCatalogIdentity()
    {
        using var fixture = new Fixture();
        var schema = fixture.Schema("Widths");
        var shapes = schema["inputs"]!.AsArray().OfType<JsonObject>().Where(input => input["sourceName"]!.ToString() != "owner").ToArray();
        Assert.Equal(new[] { 64, 32, 32, 32, 64, 32, 32 }, shapes.Select(input => input["shape"]!["bits"]!.GetValue<int>()));
        foreach (var input in shapes)
        {
            Assert.Equal("identity", input["shape"]!["kind"]!.ToString());
            Assert.Equal("identity", input["shape"]!["type"]!["kind"]!.ToString());
            Assert.Equal("source", input["shape"]!["type"]!["target"]!["kind"]!.ToString());
        }
        var entities = fixture.Compiled.Specification["data"]!["entities"]!.AsArray();
        Assert.Equal("Integer", entities.Single(entity => entity!["name"]!.ToString() == "Narrow")!["idType"]!.ToString());
        Assert.Equal("Integer", entities.Single(entity => entity!["name"]!.ToString() == "ByteKey")!["idType"]!.ToString());
        Assert.Equal("Integer", entities.Single(entity => entity!["name"]!.ToString() == "ShortKey")!["idType"]!.ToString());
        Assert.Equal("Long Integer", entities.Single(entity => entity!["name"]!.ToString() == "Wide")!["idType"]!.ToString());
        Assert.All(new ReferenceGraphBinding(schema, fixture.Assembly).Inputs.Skip(1), shape => Assert.IsType<GraphIdentity>(shape));
    }

    [Fact]
    public void NestedAndListIdentitiesKeepTheirScalarValuesAndCallerListIdentity()
    {
        using var fixture = new Fixture();
        var binding = new ReferenceGraphBinding(fixture.Schema("Echo"), fixture.Assembly);
        var owner = fixture.Owner();
        fixture.Set(owner, "Wide", fixture.Identity("Wide", long.MaxValue));
        fixture.Set(owner, "Optional", fixture.Identity("Wide", 0));
        var ids = (System.Collections.IList)Activator.CreateInstance(typeof(List<>).MakeGenericType(fixture.IdentityType("Wide")))!;
        ids.Add(fixture.Identity("Wide", 9007199254740993)); ids.Add(fixture.Identity("Wide", -1));
        fixture.Set(owner, "Ids", ids);
        var session = binding.CreateSession(); var graph = session.Encode(binding.Inputs, [owner]);
        var wire = new ReferenceGraphWire(binding.Definitions);
        var arenas = JsonNode.Parse(wire.EncodeArenas(graph).ToJsonString())!.AsObject();
        var roots = wire.EncodeRoots(graph, binding.Inputs).Select(root => JsonNode.Parse(root!.ToJsonString())).ToArray();
        Assert.Same(owner, Assert.Single(session.Reconcile(wire.Decode(arenas, roots, binding.Results), binding.Results)));
        Assert.Equal(long.MaxValue, fixture.Value(fixture.Get(owner, "Wide")!));
        Assert.Equal(0L, fixture.Value(fixture.Get(owner, "Optional")!));
        Assert.Same(ids, fixture.Get(owner, "Ids"));
        Assert.Equal(new[] { 9007199254740993L, -1L }, ids.Cast<object>().Select(fixture.Value));
    }

    [Fact]
    public void BadNestedIdentityReplyIsRejectedBeforeEarlierCallerFieldWriteback()
    {
        using var fixture = new Fixture();
        var binding = new ReferenceGraphBinding(fixture.Schema("Echo"), fixture.Assembly);
        var owner = fixture.Owner(); fixture.Set(owner, "Marker", 7);
        fixture.Set(owner, "Narrow", fixture.Identity("Narrow", 3));
        var session = binding.CreateSession(); var graph = session.Encode(binding.Inputs, [owner]);
        var wire = new ReferenceGraphWire(binding.Definitions); var arenas = wire.EncodeArenas(graph);
        var ownerDefinition = binding.Definitions.Single(definition => definition.Type.Name == "Envelope");
        arenas[ownerDefinition.Name]![0]!["Marker"] = 99;
        arenas[ownerDefinition.Name]![0]!["Narrow"] = 2147483648L;
        Assert.Throws<InvalidDataException>(() => session.Reconcile(wire.Decode(arenas, wire.EncodeRoots(graph, binding.Inputs), binding.Results), binding.Results));
        Assert.Equal(7, fixture.Get(owner, "Marker"));
        Assert.Equal(3L, fixture.Value(fixture.Get(owner, "Narrow")!));
    }

    [Theory]
    [InlineData(long.MinValue)]
    [InlineData(long.MaxValue)]
    [InlineData(9007199254740993L)]
    [InlineData(0L)]
    public void EmittedGraphEntryReturnsScalarIdentityAndReconcilesNestedIdentityFields(long value)
    {
        using var fixture = new Fixture(); var owner = fixture.Owner();
        var result = fixture.Invoke("Update", owner, fixture.Identity("Wide", value));
        Assert.Equal(fixture.IdentityType("Wide"), result!.GetType());
        Assert.Equal(value, fixture.Value(result));
        Assert.Equal(value, fixture.Value(fixture.Get(owner, "Wide")!));
        Assert.Equal(value, fixture.Value(fixture.Get(owner, "Optional")!));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void EmittedGraphEntryKeepsNullableIdentityAbsenceDistinctFromPresentZero(bool present)
    {
        using var fixture = new Fixture(); var owner = fixture.Owner();
        var result = fixture.Invoke("Optional", owner, present ? fixture.Identity("Wide", 0) : null);
        if (present)
        {
            Assert.Equal(0L, fixture.Value(result!));
            Assert.Equal(0L, fixture.Value(fixture.Get(owner, "Optional")!));
        }
        else { Assert.Null(result); Assert.Null(fixture.Get(owner, "Optional")); }
    }

    [Fact]
    public void NewCallerObjectsAreReconstructedThroughStorageWithoutBusinessConstructorsOrGetters()
    {
        var beforeConstructors = Caller.Constructions; var beforeGetters = Caller.Reads;
        var field = new GraphField("Id", typeof(Caller).GetField("id", BindingFlags.NonPublic | BindingFlags.Instance)!, new GraphIdentity(typeof(Id<Wide>), 64));
        var definition = new GraphDefinition("Callers", typeof(Caller), [field]);
        var shape = new GraphReference("Callers"); var session = new ReferenceGraphSession([definition]);
        session.Encode([shape], [null]);
        var graph = new ReferenceGraph(new Dictionary<string, IReadOnlyList<object>> { ["Callers"] = [new GraphRecord(new Dictionary<string, object?> { ["Id"] = 42L })] }, [new GraphHandle("Callers", 1)]);
        var result = Assert.IsType<Caller>(Assert.Single(session.Reconcile(graph, [shape])));
        Assert.Equal(new Id<Wide>(42), field.Storage.GetValue(result));
        Assert.Equal(beforeConstructors, Caller.Constructions);
        Assert.Equal(beforeGetters, Caller.Reads);
    }

    [Theory]
    [InlineData("root")]
    [InlineData("field")]
    [InlineData("nested")]
    [InlineData("list")]
    [InlineData("optional")]
    public void RawGraphEntryRejectsOutOfRangeInt32IdentitiesBeforeTheBusinessBody(string location)
    {
        using var fixture = new GuardFixture();
        foreach (var value in new[] { -2147483649L, 2147483648L })
        {
            var request = fixture.Request(); fixture.SetIdentity(request, location, value);
            var called = false; var probe = fixture.BodyProbe(() => called = true);
            var error = Assert.Throws<ReferenceGraphProbe.Failure>(() => probe.Run("Check", request.ToDictionary(pair => pair.Key, pair => Fixture.Native(pair.Value))));
            Assert.Equal("InvalidOperationException", error.Kind);
            Assert.Equal("Invalid C# reference graph.", error.Message);
            Assert.False(called);
        }
    }

    [Theory]
    [InlineData("root")]
    [InlineData("field")]
    [InlineData("nested")]
    [InlineData("list")]
    [InlineData("optional")]
    public void RawGraphEntryAcceptsSignedInt32ExtremesAtEveryIdentityLocation(string location)
    {
        using var fixture = new GuardFixture();
        foreach (var value in new[] { (long)int.MinValue, int.MaxValue })
        {
            var request = fixture.Request(); fixture.SetIdentity(request, location, value);
            var called = false; var probe = fixture.BodyProbe(() => called = true);
            var error = Assert.Throws<InvalidOperationException>(() => probe.Run("Check", request.ToDictionary(pair => pair.Key, pair => Fixture.Native(pair.Value))));
            Assert.Equal("Business body reached.", error.Message);
            Assert.True(called);
        }
    }

    [Fact]
    public void NativeIdentityRangeChecksOnlyApplyToPresentNullablePayloads()
    {
        using var fixture = new GuardFixture(); var request = fixture.Request();
        fixture.SetIdentity(request, "optional", long.MaxValue);
        fixture.OwnerRecord(request)["Optional"]!["HasValue"] = false;
        var called = false; var probe = fixture.BodyProbe(() => called = true);
        Assert.Throws<InvalidOperationException>(() => probe.Run("Check", request.ToDictionary(pair => pair.Key, pair => Fixture.Native(pair.Value))));
        Assert.True(called);
    }

    [Theory]
    [InlineData(int.MinValue)]
    [InlineData(int.MaxValue)]
    public void SourceIdentityConstructionForShortEntityKeysUsesTheNativeInt32Range(int value)
    {
        using var fixture = new GuardFixture();
        var result = fixture.Construct(value);
        Assert.Equal((long)value, (long)result!.GetType().GetProperty("Value")!.GetValue(result)!);
    }

    [Theory]
    [InlineData(-2147483649L)]
    [InlineData(2147483648L)]
    public void SourceIdentityConstructionRejectsValuesOutsideNativeInt32(long value)
    {
        using var fixture = new GuardFixture();
        Assert.Throws<OverflowException>(() => fixture.Construct(value));
    }

    private sealed class Wide { public Wide() => throw new InvalidOperationException("Identity transport must not construct its target entity."); }
    private sealed class Narrow;
    private readonly struct Impostor { public long Value => throw new InvalidOperationException("A source getter must never run."); }
    private readonly struct GenericImpostor<T> { public long Value => throw new InvalidOperationException("A generic source getter must never run."); }
    private sealed class Caller
    {
        public static int Constructions, Reads;
        private Id<Wide> id;
        public Caller() => Constructions++;
        public Id<Wide> Id { get { Reads++; return id; } set => id = value; }
    }

    private sealed class Fixture : IDisposable
    {
        internal const string Source = """
            using Anvil.Authoring;
            using System.ComponentModel.DataAnnotations;
            [Entity] public sealed class Wide { public Id<Wide> Id { get; set; } }
            [Entity] public sealed class Narrow { public int Id { get; set; } }
            [Entity] public sealed class ByteKey { public byte Id { get; set; } }
            [Entity] public sealed class ShortKey { [Key] public short KeyValue { get; set; } }
            [Entity] public sealed class NoKey { public int Value { get; set; } }
            public enum State { Ready, Done }
            [StaticEntity] public sealed record Kind(long Id, string Label) { public static readonly Kind Ready = new(9007199254740993, "Ready"); }
            public sealed class Envelope
            {
                public int Marker;
                public Id<Wide> Wide;
                public Id<Narrow> Narrow;
                public Id<Wide>? Optional;
                public List<Id<Wide>>? Ids;
            }
            public static class Rules
            {
                public static Envelope Echo(Envelope value) => value;
                public static Id<Wide> Update(Envelope owner, Id<Wide> id) { owner.Wide = id; owner.Optional = id; return owner.Wide; }
                public static Id<Wide>? Optional(Envelope owner, Id<Wide>? id) { owner.Optional = id; return id; }
                public static Id<Wide> Widths(Envelope owner, Id<Wide> wide, Id<Narrow> narrow, Id<ByteKey> small, Id<ShortKey> named, Id<NoKey> automatic, Id<State> state, Id<Kind> catalog) => wide;
            }
            """;
        private readonly AssemblyLoadContext context = new("identity-caller-" + Guid.NewGuid(), isCollectible: true);
        internal CompilationResult Compiled { get; }
        internal Assembly Assembly { get; }
        internal Fixture()
        {
            var files = new Dictionary<string, string> { ["Identity.cs"] = Source };
            Compiled = CSharpCompiler.CompileReferenceGraph(files);
            using var stream = new MemoryStream(); var emitted = SourceProgram.Parse(files).Compilation.Emit(stream);
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
            stream.Position = 0; Assembly = context.LoadFromStream(stream);
        }
        internal JsonObject Schema(string method) => Compiled.SourceAbis!.Single(entry => entry!["native"]!.ToString() == method)!["abi"]!.AsObject();
        internal Type IdentityType(string target) => typeof(Id<>).MakeGenericType(Assembly.GetType(target)!);
        internal object Identity(string target, long value) => Activator.CreateInstance(IdentityType(target), [value])!;
        internal long Value(object id) => (long)id.GetType().GetProperty("Value")!.GetValue(id)!;
        internal object Owner() => RuntimeHelpers.GetUninitializedObject(Assembly.GetType("Envelope")!);
        internal void Set(object target, string field, object? value) => target.GetType().GetField(field)!.SetValue(target, value);
        internal object? Get(object target, string field) => target.GetType().GetField(field)!.GetValue(target);
        internal object? Invoke(string method, params object?[] inputs)
        {
            var binding = new ReferenceGraphBinding(JsonNode.Parse(Schema(method).ToJsonString())!.AsObject(), Assembly);
            return binding.CreateCall(method).Invoke(inputs, (action, request) =>
            {
                var response = new ReferenceGraphProbe(Compiled.Specification).Run(action, request.ToDictionary(pair => pair.Key, pair => Native(pair.Value)));
                return JsonNode.Parse(JsonSerializer.Serialize(response))!.AsObject();
            });
        }
        internal static object Native(JsonNode? node) => node switch
        {
            JsonObject obj => obj.ToDictionary(pair => pair.Key, pair => Native(pair.Value)),
            JsonArray list => list.Select(Native).ToList(),
            JsonValue value when value.TryGetValue<string>(out var text) => text,
            JsonValue value when value.TryGetValue<bool>(out var flag) => flag,
            JsonValue value => decimal.Parse(value.ToJsonString(), System.Globalization.CultureInfo.InvariantCulture),
            _ => throw new InvalidDataException("Native values require explicit presence.")
        };
        public void Dispose() => context.Unload();
    }

    private sealed class GuardFixture : IDisposable
    {
        internal const string Source = """
            using Anvil.Authoring;
            using System.ComponentModel.DataAnnotations;
            [Entity] public sealed class Small { [Key] public short StoredKey { get; set; } }
            public struct Nested { public Id<Small> Id; }
            public sealed class GuardEnvelope
            {
                public int Marker;
                public Id<Small> Direct;
                public Id<Small>? Optional;
                public Nested Nested;
                public List<Id<Small>>? Ids;
            }
            public static class Rules
            {
                public static Id<Small> Check(IDataSession database, GuardEnvelope owner, Id<Small> id)
                {
                    var count = database.Query<Small>().Count();
                    owner.Marker = count;
                    return id;
                }
                public static Id<Small> Construct(GuardEnvelope owner, long value) { owner.Marker = 1; return new Id<Small>(value); }
            }
            """;
        private readonly AssemblyLoadContext context = new("identity-entry-" + Guid.NewGuid(), isCollectible: true);
        private readonly CompilationResult compiled;
        private readonly Assembly assembly;
        private readonly ReferenceGraphBinding binding;
        private readonly Type idType, ownerType;
        internal GuardFixture()
        {
            var files = new Dictionary<string, string> { ["IdentityGuard.cs"] = Source };
            compiled = CSharpCompiler.CompileReferenceGraph(files);
            using var stream = new MemoryStream(); var emitted = SourceProgram.Parse(files).Compilation.Emit(stream);
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
            stream.Position = 0; assembly = context.LoadFromStream(stream);
            idType = typeof(Id<>).MakeGenericType(assembly.GetType("Small")!); ownerType = assembly.GetType("GuardEnvelope")!;
            binding = Binding("Check");
        }
        private ReferenceGraphBinding Binding(string method) => new(compiled.SourceAbis!.Single(entry => entry!["native"]!.ToString() == method)!["abi"]!.AsObject(), assembly);
        internal JsonObject Request()
        {
            var owner = RuntimeHelpers.GetUninitializedObject(ownerType);
            var id = Activator.CreateInstance(idType, [0L])!;
            ownerType.GetField("Optional")!.SetValue(owner, id);
            var ids = (System.Collections.IList)Activator.CreateInstance(typeof(List<>).MakeGenericType(idType))!; ids.Add(id);
            ownerType.GetField("Ids")!.SetValue(owner, ids);
            var session = binding.CreateSession(); var graph = session.Encode(binding.Inputs, [owner, id]); var wire = new ReferenceGraphWire(binding.Definitions);
            var roots = wire.EncodeRoots(graph, binding.Inputs); var request = new JsonObject { ["AvGraphIn"] = wire.EncodeArenas(graph) };
            for (var index = 0; index < roots.Count; index++) request[binding.InputNames[index]] = roots[index];
            return request;
        }
        internal JsonObject OwnerRecord(JsonObject request) => request["AvGraphIn"]![binding.Definitions.Single(definition => definition.Type == ownerType).Name]![0]!.AsObject();
        internal void SetIdentity(JsonObject request, string location, long value)
        {
            if (location == "root") request["Arg_id"] = value;
            else if (location == "field") OwnerRecord(request)["Direct"] = value;
            else if (location == "nested") OwnerRecord(request)["Nested"]!["Id"] = value;
            else if (location == "optional") OwnerRecord(request)["Optional"]!["Value"] = value;
            else request["AvGraphIn"]![binding.Definitions.Single(definition => definition.Element != null).Name]![0]!["Items"]![0] = value;
        }
        internal ReferenceGraphProbe BodyProbe(Action reached) => new(compiled.Specification)
        { DataEffect = (_, _) => { reached(); throw new InvalidOperationException("Business body reached."); } };
        internal object? Construct(long value) => Binding("Construct").CreateCall("Construct").Invoke([RuntimeHelpers.GetUninitializedObject(ownerType), value], (method, request) =>
            JsonNode.Parse(JsonSerializer.Serialize(new ReferenceGraphProbe(compiled.Specification).Run(method, request.ToDictionary(pair => pair.Key, pair => Fixture.Native(pair.Value)))))!.AsObject());
        public void Dispose() => context.Unload();
    }
}
