using System.Collections;
using System.Globalization;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Authoring.Transport;
using Xunit;

namespace Anvil.CSharp.Tests;

public sealed class TemporalGraphBoundaryTests
{
    public static IEnumerable<object[]> Values()
    {
        foreach (var value in new object[] { DateOnly.MinValue, DateOnly.MaxValue, new DateOnly(2000, 2, 29),
            TimeOnly.MinValue, TimeOnly.MaxValue, new TimeOnly(123456789), TimeSpan.MinValue, TimeSpan.MaxValue, TimeSpan.FromTicks(-1),
            DateTime.MinValue, new DateTime(DateTime.MaxValue.Ticks, DateTimeKind.Utc), new DateTime(638662950000000123, DateTimeKind.Local),
            DateTimeOffset.MinValue, DateTimeOffset.MaxValue,
            new DateTimeOffset(14 * TimeSpan.TicksPerHour, TimeSpan.FromHours(14)),
            new DateTimeOffset(DateTime.MaxValue.Ticks - 14 * TimeSpan.TicksPerHour, TimeSpan.FromHours(-14)) })
            yield return [value];
    }

    [Theory]
    [MemberData(nameof(Values))]
    public void ExactValuesRoundtripThroughSdkAndCompiledEntriesInRootsStateArraysAndLists(object value)
    {
        var type = value.GetType();
        using var fixture = new Fixture(type);
        SameValue(fixture.Clr("Echo", value)!, fixture.Invoke("Echo", value));
        SameValue(value, fixture.Invoke("Echo", value));
        SameValue(value, fixture.Invoke("Maybe", value));
        Assert.Null(fixture.Invoke("Maybe", new object?[] { null }));
        var state = fixture.NewState();
        var clrState = fixture.NewState();
        Assert.Same(clrState, fixture.Clr("Update", clrState, value, value));
        Assert.Same(state, fixture.Invoke("Update", state, value, value));
        SameValue(fixture.Field(clrState, "Value")!, fixture.Field(state, "Value"));
        Assert.Equal(fixture.Field(clrState, "Visits"), fixture.Field(state, "Visits"));
        SameValue(value, fixture.Field(state, "Value")); SameValue(value, fixture.Field(state, "Optional"));
        SameValue(value, Assert.Single(((IList)fixture.Field(state, "Items")!).Cast<object>()));
        SameValue(value, ((IList)fixture.Field(state, "Slots")!)[0]);
        Assert.Equal(1, fixture.Field(state, "Visits"));
        Assert.Same(state, fixture.Invoke("Update", state, value, null));
        Assert.Null(fixture.Field(state, "Optional")); Assert.Equal(2, fixture.Field(state, "Visits"));
        var failure = Assert.Throws<InvalidOperationException>(() => fixture.Invoke("Fail", state, value));
        Assert.Equal("temporal failure", failure.Message); Assert.Equal(9, fixture.Field(state, "Visits"));
        SameValue(value, fixture.Field(state, "Value"));
        var array = Assert.IsAssignableFrom<Array>(fixture.Invoke("Array", value)); SameValue(value, array.GetValue(0));
        var structResult = fixture.Invoke("Inline", value)!;
        SameValue(value, structResult.GetType().GetProperty("Value")!.GetValue(structResult));
        var optionalStruct = fixture.Invoke("InlineOptional", value)!;
        SameValue(value, optionalStruct.GetType().GetProperty("Value")!.GetValue(optionalStruct));
        var absentStruct = fixture.Invoke("InlineOptional", new object?[] { null })!;
        Assert.Null(absentStruct.GetType().GetProperty("Value")!.GetValue(absentStruct));
        if (type == typeof(DateTime))
        {
            fixture.RequireOptionalInlineDateTimeSchema();
            Assert.Equal(((DateTime)value).Kind, fixture.Invoke("ReadKind", value));
        }
        Assert.Equal(4, fixture.LastAbi!["version"]!.GetValue<int>());
        Assert.Equal(4, fixture.LastResponse!["AvGraphAbiOut"]!.GetValue<int>());
        Assert.Equal(0, fixture.LastResponse["AvCompletion"]!["ExceptionRef"]!.GetValue<int>());
        Assert.False(fixture.LastResponse.ContainsKey("AvErrors"));
        // The type is recognized by a fixed BCL codec, with no reflected BCL fields.
        Assert.Contains("\"kind\":\"temporal\"", fixture.LastAbi.ToJsonString());
        Assert.DoesNotContain("System.Private.CoreLib", fixture.LastAbi.ToJsonString());
    }

    [Theory]
    [InlineData("public static class Rules { public static DateOnly Echo(DateOnly value) => value; }", "System.DateOnly", true, "01a2c1227e0bdb645708296e32708b289073b537d409c74b930ff90454be1b2f")]
    [InlineData("public sealed record R(DateOnly Value); public static class Rules { public static R Echo(R value) => value; }", "System.DateOnly", false, "cfa791f520d096dcec580cc0be530f16c6dca77a034aaf0abc8b8222ae0059a3")]
    [InlineData("public sealed record R(DateTimeOffset Value); public static class Rules { public static R Echo(R value) => value; }", "System.DateTimeOffset", false, "3be0bf53a52c34bdc925207fd4d7844bf6535ec29436c152ad32a88c7be224a1")]
    [InlineData("public sealed record R(TimeSpan Value); public static class Rules { public static R Echo(R value) => value; }", "System.TimeSpan", false, "32474dc5b91d7c76957a8006e64c8ec9906800aa430013b5c8dd2a5030e0cb07")]
    public void OriginalAutomaticCapabilityMatrixSourcesNowUseAnExactNegotiatedTemporalCodec(string source, string typeName, bool scalar, string sourceHash)
    {
        var files = new Dictionary<string, string> { ["Automatic.cs"] = source };
        var compiled = CSharpCompiler.CompileReferenceGraph(files); Assert.Equal(sourceHash, compiled.SourceHash);
        var load = new AssemblyLoadContext("original-temporal-matrix-" + Guid.NewGuid(), true);
        try
        {
            using var bytes = new MemoryStream(); var emitted = SourceProgram.Parse(files).Compilation.Emit(bytes);
            Assert.True(emitted.Success, string.Join("\n", emitted.Diagnostics)); bytes.Position = 0;
            var assembly = load.LoadFromStream(bytes);
            var temporal = typeof(object).Assembly.GetType(typeName)!;
            var value = temporal == typeof(DateOnly) ? (object)DateOnly.MaxValue
                : temporal == typeof(TimeSpan) ? TimeSpan.MinValue : new DateTimeOffset(14 * TimeSpan.TicksPerHour, TimeSpan.FromHours(14));
            var input = scalar ? value : Activator.CreateInstance(assembly.GetType("R")!, value)!;
            var expected = assembly.GetType("Rules")!.GetMethod("Echo")!.Invoke(null, [input]);
            var abi = Assert.Single(compiled.SourceAbis!)!["abi"]!.AsObject(); Assert.Equal(4, abi["version"]!.GetValue<int>());
            var binding = new ReferenceGraphBinding(abi, assembly, 4); var probe = new ReferenceGraphProbe(compiled.Specification);
            var result = binding.CreateCall("Echo").Invoke([input], (action, request) => JsonSerializer.SerializeToNode(probe.Run(action,
                request.ToDictionary(pair => pair.Key, pair => Fixture.Native(pair.Value))))!.AsObject());
            if (scalar) SameValue(expected!, result);
            else { Assert.Same(input, result); SameValue(value, result!.GetType().GetProperty("Value")!.GetValue(result)); }
        }
        finally { load.Unload(); }
    }

    [Theory]
    [InlineData("System.DateOnly")]
    [InlineData("System.TimeOnly")]
    [InlineData("System.TimeSpan")]
    [InlineData("System.DateTime")]
    [InlineData("System.DateTimeOffset")]
    public void NullableAbsenceCarriesTheCanonicalNativeTemporalDefault(string name)
    {
        var type = typeof(object).Assembly.GetType(name)!; using var fixture = new Fixture(type);
        Assert.Null(fixture.Invoke("Maybe", new object?[] { null }));
        var input = fixture.LastRequest!["Arg_value"]!;
        Assert.False(input["HasValue"]!.GetValue<bool>());
        Assert.All(input["Value"]!.AsObject(), field => Assert.Equal(0m, decimal.Parse(field.Value!.ToJsonString(), CultureInfo.InvariantCulture)));
    }

    [Fact]
    public void Version2And3CannotAcceptTemporalMetadataOrInvokeVersion4()
    {
        using var fixture = new Fixture(typeof(DateOnly));
        var abi = fixture.Abi("Echo");
        Assert.Throws<InvalidDataException>(() => new ReferenceGraphBinding(abi, fixture.Assembly, maxSupportedVersion: 2));
        Assert.Throws<InvalidDataException>(() => new ReferenceGraphBinding(abi, fixture.Assembly, maxSupportedVersion: 3));
        var downgraded = abi.DeepClone().AsObject(); downgraded["version"] = 3;
        Assert.Throws<InvalidDataException>(() => new ReferenceGraphBinding(downgraded, fixture.Assembly, maxSupportedVersion: 4));
        Assert.Throws<ArgumentException>(() => new ReferenceGraphSession([], 3).Encode([new GraphTemporal(typeof(DateOnly))], [DateOnly.MinValue]));
        var sourceType = new GraphTemporal(fixture.Assembly.GetType("InlineValue")!);
        Assert.Throws<ArgumentException>(() => new ReferenceGraphSession([], 4).Encode([sourceType], [Activator.CreateInstance(sourceType.Type)]));
    }

    [Theory]
    [InlineData("Echo", "input")]
    [InlineData("Echo", "result")]
    [InlineData("Maybe", "input")]
    [InlineData("Maybe", "result")]
    public void TemporalTypesCannotBypassTheirCodecUsingAnEmptyInlineDescriptor(string method, string root)
    {
        using var fixture = new Fixture(typeof(DateTime)); var abi = fixture.Abi(method);
        var shape = (root == "input" ? abi["inputs"]![0]!["shape"] : abi["results"]![0])!.AsObject();
        if (method == "Maybe") shape = shape["value"]!.AsObject();
        shape["kind"] = "inline"; shape["fields"] = new JsonArray();
        Assert.Throws<InvalidDataException>(() => new ReferenceGraphBinding(abi, fixture.Assembly, 4));
        Assert.Throws<ArgumentException>(() => new ReferenceGraphSession([], 4).Encode([new GraphInline(typeof(DateTime), [])], [DateTime.UtcNow]));
    }

    [Fact]
    public void ALocalDateTimeWhoseAmbiguityStateCannotFitTicksAndKindIsRejectedBeforeTransport()
    {
        // Find a real ambiguous local value using the host's BCL timezone rules. The
        // specific transition is data; the codec never rewrites ticks to another UTC instant.
        DateTime? ambiguous = null;
        for (var year = 2000; year <= 2025 && ambiguous == null; year++)
            for (var day = 0; day < 366 && ambiguous == null; day++)
            {
                var utc = new DateTime(year, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddDays(day);
                for (var hour = 0; hour < 24; hour++)
                {
                    var local = utc.AddHours(hour).AddMinutes(30).ToLocalTime();
                    if (local.ToBinary() != new DateTime(local.Ticks, local.Kind).ToBinary()) { ambiguous = local; break; }
                }
            }
        if (ambiguous == null) return; // UTC/fixed-offset hosts have no ambiguous local state to send.
        using var fixture = new Fixture(typeof(DateTime));
        var binding = new ReferenceGraphBinding(fixture.Abi("Echo"), fixture.Assembly, 4);
        var reached = 0;
        var error = Assert.Throws<InvalidDataException>(() => binding.CreateCall("Echo").Invoke([ambiguous.Value], (_, _) => { reached++; throw new Exception("transport reached"); }));
        Assert.Contains("ambiguous daylight-saving state", error.Message); Assert.Equal(0, reached);
    }

    [Theory]
    [InlineData("System.DateOnly", "DayNumber", "-1")]
    [InlineData("System.DateOnly", "DayNumber", "3652059")]
    [InlineData("System.DateOnly", "DayNumber", "1.5")]
    [InlineData("System.TimeOnly", "Ticks", "864000000000")]
    [InlineData("System.TimeSpan", "Ticks", "9223372036854775808")]
    [InlineData("System.DateTime", "Ticks", "3155378976000000000")]
    [InlineData("System.DateTime", "Kind", "3")]
    [InlineData("System.DateTimeOffset", "OffsetMinutes", "841")]
    [InlineData("System.DateTimeOffset", "OffsetMinutes", "-1")]
    public void MalformedOutputIsRejectedAtomicallyBeforeCallerStateChanges(string name, string field, string invalid)
    {
        var type = typeof(object).Assembly.GetType(name)!; using var fixture = new Fixture(type);
        var value = Activator.CreateInstance(type)!; var state = fixture.NewState();
        var original = ((IList)fixture.Field(state, "Items")!).Count;
        var error = Assert.Throws<InvalidDataException>(() => fixture.Invoke("Update", response => {
            var arena = response["AvGraphOut"]!.AsObject().Single(pair => pair.Value is JsonArray cells && cells.FirstOrDefault()?["Visits"] != null).Value!.AsArray();
            arena[0]!["Value"]![field] = JsonNode.Parse(invalid);
        }, state, value, value));
        Assert.NotEmpty(error.Message);
        Assert.Equal(0, fixture.Field(state, "Visits")); Assert.Equal(original, ((IList)fixture.Field(state, "Items")!).Count);
    }

    [Theory]
    [InlineData("System.DateOnly", "DayNumber", "-1")]
    [InlineData("System.DateOnly", "DayNumber", "3652059")]
    [InlineData("System.DateOnly", "DayNumber", "1.5")]
    [InlineData("System.TimeOnly", "Ticks", "864000000000")]
    [InlineData("System.TimeSpan", "Ticks", "9223372036854775808")]
    [InlineData("System.DateTime", "Ticks", "3155378976000000000")]
    [InlineData("System.DateTime", "Kind", "3")]
    [InlineData("System.DateTime", "Kind", "1.5")]
    [InlineData("System.DateTimeOffset", "UtcTicks", "3155378976000000000")]
    [InlineData("System.DateTimeOffset", "OffsetMinutes", "841")]
    [InlineData("System.DateTimeOffset", "OffsetMinutes", "-1")]
    public void GeneratedEntryRejectsInvalidTemporalDomainBeforeBusinessDataEffects(string name, string field, string invalid)
    {
        var type = typeof(object).Assembly.GetType(name)!; using var fixture = new Fixture(type);
        var request = fixture.Request("Inspect", Activator.CreateInstance(type));
        request["Arg_value"]![field] = JsonNode.Parse(invalid);
        var reached = 0; fixture.DataEffect = (_, _) => { reached++; throw new InvalidOperationException("business data effect reached"); };
        var error = Assert.Throws<ReferenceGraphProbe.Failure>(() => fixture.Raw("Inspect", request));
        Assert.Equal("InvalidOperationException", error.Kind); Assert.Equal("Invalid C# reference graph.", error.Message); Assert.Equal(0, reached);
    }

    [Fact]
    public void GeneratedEntryRejectsInactivePayloadAndVersionMismatchBeforeBusinessDataEffects()
    {
        using var fixture = new Fixture(typeof(DateTimeOffset));
        var reached = 0; fixture.DataEffect = (_, _) => { reached++; throw new InvalidOperationException("business data effect reached"); };
        var absent = fixture.Request("InspectOptional", new object?[] { null });
        absent["Arg_value"]!["Value"]!["UtcTicks"] = 1;
        Assert.Throws<ReferenceGraphProbe.Failure>(() => fixture.Raw("InspectOptional", absent)); Assert.Equal(0, reached);
        var wrongVersion = fixture.Request("Inspect", DateTimeOffset.MinValue); wrongVersion["AvGraphAbiIn"] = 3;
        Assert.Throws<ReferenceGraphProbe.Failure>(() => fixture.Raw("Inspect", wrongVersion)); Assert.Equal(0, reached);
        var valid = fixture.Request("Inspect", new DateTimeOffset(14 * TimeSpan.TicksPerHour, TimeSpan.FromHours(14)));
        var marker = Assert.Throws<InvalidOperationException>(() => fixture.Raw("Inspect", valid));
        Assert.Equal("business data effect reached", marker.Message); Assert.Equal(1, reached);
    }

    private static void SameValue(object expected, object? actual)
    {
        Assert.NotNull(actual); Assert.Equal(expected.GetType(), actual.GetType());
        if (expected is DateTime date) { var other = Assert.IsType<DateTime>(actual); Assert.Equal(date.Ticks, other.Ticks); Assert.Equal(date.Kind, other.Kind); }
        else if (expected is DateTimeOffset offset) { var other = Assert.IsType<DateTimeOffset>(actual); Assert.Equal(offset.UtcTicks, other.UtcTicks); Assert.Equal(offset.Offset, other.Offset); Assert.Equal(offset.Ticks, other.Ticks); }
        else Assert.Equal(expected, actual);
    }

    private sealed class Fixture : IDisposable
    {
        private readonly AssemblyLoadContext load = new("temporal-graph-" + Guid.NewGuid(), true);
        private readonly CompilationResult compiled;
        private readonly ReferenceGraphProbe probe;
        internal Assembly Assembly { get; }
        internal JsonObject? LastAbi { get; private set; }
        internal JsonObject? LastRequest { get; private set; }
        internal JsonObject? LastResponse { get; private set; }
        internal Func<JsonObject, IReadOnlyDictionary<string, object>, Dictionary<string, object>>? DataEffect { set => probe.DataEffect = value; }
        internal Fixture(Type type)
        {
            var kindMethod = type == typeof(DateTime) ? "public static DateTimeKind ReadKind(DateTime value) => value.Kind;" : "";
            var source = $$"""
                using Anvil.Authoring;
                [Entity] public sealed class Journal { [System.ComponentModel.DataAnnotations.Key] public int StoredKey { get; set; } }
                public sealed class State { public {{type.FullName}} Value; public {{type.FullName}}? Optional; public int Visits; public List<{{type.FullName}}> Items = new(); public {{type.FullName}}[] Slots = new {{type.FullName}}[1]; }
                public readonly record struct InlineValue({{type.FullName}} Value);
                public readonly record struct InlineOptionalValue({{type.FullName}}? Value);
                public static class Rules {
                    {{kindMethod}}
                    public static {{type.FullName}} Echo({{type.FullName}} value) => value;
                    public static {{type.FullName}}? Maybe({{type.FullName}}? value) => value;
                    public static State Update(State state, {{type.FullName}} value, {{type.FullName}}? optional) { state.Visits++; state.Value=value; state.Optional=optional; state.Items.Add(value); state.Slots[0]=value; return state; }
                    public static {{type.FullName}}[] Array({{type.FullName}} value) => new[] { value };
                    public static InlineValue Inline({{type.FullName}} value) => new InlineValue(value);
                    public static InlineOptionalValue InlineOptional({{type.FullName}}? value) => new InlineOptionalValue(value);
                    public static {{type.FullName}} Fail(State state, {{type.FullName}} value) { state.Value=value; state.Visits=9; throw new InvalidOperationException("temporal failure"); }
                    public static {{type.FullName}} Inspect(IDataSession database, {{type.FullName}} value) { var count = database.Query<Journal>().Count(); return value; }
                    public static {{type.FullName}}? InspectOptional(IDataSession database, {{type.FullName}}? value) { var count = database.Query<Journal>().Count(); return value; }
                }
                """;
            var files = new Dictionary<string, string> { ["TemporalGraph.cs"] = source };
            using var bytes = new MemoryStream(); var emitted = SourceProgram.Parse(files).Compilation.Emit(bytes);
            Assert.True(emitted.Success, string.Join("\n", emitted.Diagnostics)); bytes.Position = 0; Assembly = load.LoadFromStream(bytes);
            compiled = CSharpCompiler.CompileReferenceGraph(files); probe = new(compiled.Specification);
        }
        internal object NewState() => Activator.CreateInstance(Assembly.GetType("State")!)!;
        internal object? Field(object owner, string field) => owner.GetType().GetField(field)!.GetValue(owner);
        internal object? Clr(string method, params object?[] arguments) => Assembly.GetType("Rules")!.GetMethod(method)!.Invoke(null, arguments);
        internal JsonObject Abi(string method) => compiled.SourceAbis!.Single(item => item!["native"]!.ToString() == method)!["abi"]!.DeepClone().AsObject();
        internal void RequireOptionalInlineDateTimeSchema()
        {
            var action = compiled.Specification["logic"]!["actions"]!.AsArray().Single(item => item!["name"]!.ToString() == "InlineOptional")!;
            var structures = compiled.Specification["data"]!["structures"]!.AsArray();
            JsonNode Structure(string name) => structures.Single(item => item!["name"]!.ToString() == name)!;
            var inline = Structure(action["outputs"]![0]!["type"]!.ToString());
            var optional = Structure(inline["attributes"]![0]!["type"]!.ToString());
            var exact = Structure(optional["attributes"]!.AsArray().Single(item => item!["name"]!.ToString() == "Value")!["type"]!.ToString());
            Assert.Equal(new[] { "Ticks", "Kind" }, exact["attributes"]!.AsArray().Select(item => item!["name"]!.ToString()));
        }
        internal object? Invoke(string method, params object?[] arguments) => Invoke(method, null, arguments);
        internal JsonObject Request(string method, params object?[] arguments)
        {
            var binding = new ReferenceGraphBinding(Abi(method), Assembly, 4);
            var session = binding.CreateSession(); var encoded = session.Encode(binding.Inputs, arguments); var wire = binding.CreateWire();
            var roots = wire.EncodeRoots(encoded, binding.Inputs); var request = new JsonObject { ["AvGraphAbiIn"] = 4, ["AvGraphIn"] = wire.EncodeArenas(encoded) };
            for (var i = 0; i < roots.Count; i++) request[binding.InputNames[i]] = roots[i];
            return request;
        }
        internal JsonObject Raw(string method, JsonObject request) => JsonSerializer.SerializeToNode(probe.Run(method,
            request.ToDictionary(pair => pair.Key, pair => Native(pair.Value))))!.AsObject();
        internal object? Invoke(string method, Action<JsonObject>? changeResponse, params object?[] arguments)
        {
            LastAbi = Abi(method); var binding = new ReferenceGraphBinding(LastAbi, Assembly, maxSupportedVersion: 4);
            return binding.CreateCall(method).Invoke(arguments, (action, request) => {
                LastRequest = request.DeepClone().AsObject();
                LastResponse = JsonSerializer.SerializeToNode(probe.Run(action, request.ToDictionary(pair => pair.Key, pair => Native(pair.Value))))!.AsObject();
                changeResponse?.Invoke(LastResponse); return LastResponse;
            });
        }
        internal static object Native(JsonNode? node) => node switch {
            JsonObject record => record.ToDictionary(pair => pair.Key, pair => Native(pair.Value)), JsonArray list => list.Select(Native).ToList(),
            JsonValue value when value.TryGetValue<string>(out var text) => text, JsonValue value when value.TryGetValue<bool>(out var flag) => flag,
            JsonValue value => decimal.Parse(value.ToJsonString(), CultureInfo.InvariantCulture), _ => throw new InvalidDataException("Native presence is explicit.")
        };
        public void Dispose() => load.Unload();
    }
}
