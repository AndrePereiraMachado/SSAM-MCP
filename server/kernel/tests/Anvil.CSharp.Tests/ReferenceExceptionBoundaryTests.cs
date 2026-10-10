using Anvil.Authoring.Transport;
using System.Globalization;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;
using System.Text.Json.Nodes;
using Xunit;

namespace Anvil.CSharp.Tests;

// Compiler -> portable SDK ABI -> emitted native entry/body executed by the copy-semantics
// probe. These are not HTTP fixtures, source interpretation, O11 Verify or server execution.
public class ReferenceExceptionBoundaryTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ExceptionArgumentStateAndResultRetainOneIdentityIncludingNull(bool absent)
    {
        using var call = new BoundaryCall("""
            public sealed class State { public int Visits; public Exception? Saved; }
            public static class Rules {
                public static Exception? Remember(State state, Exception? error) {
                    state.Visits++;
                    state.Saved = error;
                    return error;
                }
            }
            """, "Remember");
        var state = call.New("State"); Exception? original = absent ? null : new ArgumentNullException("name", "missing");
        var result = call.Invoke(state, original);
        Assert.Equal(3, call.Abi["version"]!.GetValue<int>());
        Assert.Equal("Exceptions", call.Abi["exceptionArena"]!.GetValue<string>());
        Assert.Same(original, result); Assert.Same(original, call.Field(state, "Saved"));
        Assert.Equal(1, call.Field(state, "Visits"));
        Assert.Equal(absent ? 0 : 1, call.Exceptions.Count);
        Assert.Equal(0, call.LastResponse!["AvCompletion"]!["ExceptionRef"]!.GetValue<int>());
    }

    [Fact]
    public void ExistingExceptionIsWrittenIntoStateAndThrownAsTheSameCallerObject()
    {
        using var call = new BoundaryCall("""
            public sealed class State { public int Visits; public Exception? Saved; }
            public static class Rules {
                public static Exception RememberAndThrow(State state, Exception error) {
                    state.Visits++;
                    state.Saved = error;
                    throw error;
                }
            }
            """, "RememberAndThrow");
        var state = call.New("State"); var inner = new FormatException("inner");
        var original = new InvalidOperationException("original", inner);
        var thrown = Assert.Throws<InvalidOperationException>(() => call.Invoke(state, original));
        Assert.Same(original, thrown); Assert.Same(original, call.Field(state, "Saved"));
        Assert.Same(inner, thrown.InnerException); Assert.Equal(1, call.Field(state, "Visits"));
        Assert.Equal(2, call.Exceptions.Count);
        Assert.Equal(2, call.LastResponse!["AvCompletion"]!["Kind"]!.GetValue<int>());
        Assert.Equal(0, call.LastResponse["AvResult"]!["Index"]!.GetValue<int>());
        Assert.False(call.LastResponse.ContainsKey("AvErrors"));
    }

    [Fact]
    public void NewlyConstructedExceptionSharesStateAndThrownCompletionWithoutDoubleSuffix()
    {
        using var call = new BoundaryCall("""
            public sealed class State { public int Visits; public Exception? Saved; }
            public static class Rules {
                public static void CreateAndThrow(State state) {
                    var error = new ArgumentException("invalid", "request");
                    state.Saved = error;
                    state.Visits = 8;
                    throw error;
                }
            }
            """, "CreateAndThrow");
        var state = call.New("State"); var error = Assert.Throws<ArgumentException>(() => call.Invoke(state));
        Assert.Same(error, call.Field(state, "Saved")); Assert.Equal(8, call.Field(state, "Visits"));
        Assert.Equal("request", error.ParamName); Assert.Equal("invalid (Parameter 'request')", error.Message);
        Assert.Equal(-2147024809, error.HResult); Assert.Single(call.Exceptions);
        Assert.False(call.LastResponse!.ContainsKey("AvResult"));
    }

    [Fact]
    public void ListArrayResultAndExistingExceptionShareIdentitiesAcrossNativeMutation()
    {
        using var call = new BoundaryCall("""
            public static class Rules {
                public static Exception Publish(List<Exception?> errors, Exception?[] slots, Exception existing) {
                    var created = new ArgumentException("added", "items");
                    errors.Add(existing);
                    errors.Add(created);
                    slots[0] = created;
                    slots[1] = existing;
                    return created;
                }
            }
            """, "Publish");
        var existing = new InvalidOperationException("old"); var errors = new List<Exception?> { null };
        var slots = new Exception?[2]; var enumerator = errors.GetEnumerator();
        var result = Assert.IsType<ArgumentException>(call.Invoke(errors, slots, existing));
        Assert.Equal(3, errors.Count); Assert.Null(errors[0]); Assert.Same(existing, errors[1]);
        Assert.Same(result, errors[2]); Assert.Same(result, slots[0]); Assert.Same(existing, slots[1]);
        Assert.Equal("items", result.ParamName); Assert.Equal("added (Parameter 'items')", result.Message);
        Assert.Equal(2, call.Exceptions.Count);
        Assert.Throws<InvalidOperationException>(() => enumerator.MoveNext());
    }

    [Fact]
    public void NewlyExportedExceptionsRemapSharedInnerAsAForwardReference()
    {
        using var call = new BoundaryCall("""
            public sealed class State { public Exception? First; public Exception? Second; }
            public static class Rules {
                public static Exception Build(State state) {
                    var inner = new FormatException("shared");
                    var first = new InvalidOperationException("first", inner);
                    state.First = first;
                    state.Second = new ArgumentException("second", "request", inner);
                    return first;
                }
            }
            """, "Build");
        var state = call.New("State"); var result = Assert.IsType<InvalidOperationException>(call.Invoke(state));
        var second = Assert.IsType<ArgumentException>(call.Field(state, "Second"));
        Assert.Same(result, call.Field(state, "First")); Assert.Same(result.InnerException, second.InnerException);
        Assert.IsType<FormatException>(result.InnerException); Assert.Equal("shared", result.InnerException!.Message);
        Assert.Equal("first", result.Message); Assert.Equal("request", second.ParamName);
        Assert.Equal(3, call.Exceptions.Count);
        var firstCell = call.Exceptions.Select(node => node!.AsObject()).Single(cell => cell["Message"]!.GetValue<string>() == "first");
        var secondCell = call.Exceptions.Select(node => node!.AsObject()).Single(cell => cell["TypeName"]!.GetValue<string>() == "System.ArgumentException");
        Assert.Equal(3, firstCell["InnerRef"]!.GetValue<int>()); Assert.Equal(3, secondCell["InnerRef"]!.GetValue<int>());
    }

    [Fact]
    public void FailureExportsItsExceptionButNotAnUnreturnedExceptionLocal()
    {
        using var call = new BoundaryCall("""
            public sealed class State { public Exception? Saved; }
            public static class Rules {
                public static Exception Choose(State state, bool fail) {
                    var unreturned = new Exception("hidden local");
                    if (fail) {
                        state.Saved = new InvalidOperationException("visible failure");
                        throw state.Saved;
                    }
                    return unreturned;
                }
            }
            """, "Choose");
        var state = call.New("State"); var error = Assert.Throws<InvalidOperationException>(() => call.Invoke(state, true));
        Assert.Same(error, call.Field(state, "Saved")); Assert.Equal("visible failure", error.Message);
        Assert.Equal("visible failure", Assert.Single(call.Exceptions)!["Message"]!.GetValue<string>());
        Assert.Equal(0, call.LastResponse!["AvResult"]!["Index"]!.GetValue<int>());
        Assert.Equal(1, call.LastResponse["AvCompletion"]!["ExceptionRef"]!.GetValue<int>());
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("é😀")]
    public void ArgumentOutOfRangeActualValuePreservesNullEmptyAndTextFromAVariable(string? actual)
    {
        using var call = new BoundaryCall("""
            public sealed class State { public Exception? Saved; }
            public static class Rules {
                public static Exception Create(State state, string? actual) {
                    var error = new ArgumentOutOfRangeException("value", actual, "outside");
                    state.Saved = error;
                    return error;
                }
            }
            """, "Create");
        var state = call.New("State"); var error = Assert.IsType<ArgumentOutOfRangeException>(call.Invoke(state, actual));
        Assert.Same(error, call.Field(state, "Saved")); Assert.Equal(actual, error.ActualValue);
        Assert.Equal("value", error.ParamName);
        Assert.Equal("outside (Parameter 'value')" + (actual == null ? "" : Environment.NewLine + "Actual value was " + actual + "."), error.Message);
        var payload = Assert.Single(call.Exceptions)!;
        Assert.Equal(actual != null, payload["HasActualValue"]!.GetValue<bool>());
        Assert.Equal(actual == null ? "" : "System.String", payload["ActualValueType"]!.GetValue<string>());
        Assert.Equal(actual ?? "", payload["ActualValueText"]!.GetValue<string>());
        Assert.Equal(0, payload["ActualValueInteger"]!.GetValue<int>()); Assert.Equal(0L, payload["ActualValueLong"]!.GetValue<long>());
        Assert.False(payload["ActualValueBoolean"]!.GetValue<bool>());
    }

    [Theory]
    [InlineData("handshake")]
    [InlineData("negativeRoot")]
    [InlineData("pastArenaRoot")]
    [InlineData("wrongDeclaredType")]
    [InlineData("unknownType")]
    [InlineData("innerBounds")]
    [InlineData("innerCycle")]
    [InlineData("inactiveActualSlot")]
    [InlineData("unknownActualType")]
    [InlineData("missingHResult")]
    [InlineData("invalidParameterPayload")]
    [InlineData("messageSuffix")]
    public void InvalidNativeExceptionInputIsRejectedBeforeTheFirstBusinessDataEffect(string invalid)
    {
        using var call = new BoundaryCall(GuardSource, "Inspect");
        var state = call.New("State"); var request = call.Request(state, new ArgumentException("input", "request"));
        var payload = request["AvGraphIn"]!["Exceptions"]![0]!;
        switch (invalid) {
            case "handshake": request["AvGraphAbiIn"] = 2; break;
            case "negativeRoot": request["Arg_error"]!["Index"] = -1; break;
            case "pastArenaRoot": request["Arg_error"]!["Index"] = 2; break;
            case "wrongDeclaredType": payload["TypeName"] = "System.Exception"; payload["HasParamName"] = false; payload["ParamName"] = ""; break;
            case "unknownType": payload["TypeName"] = "System.IO.IOException"; break;
            case "innerBounds": payload["InnerRef"] = 2; break;
            case "innerCycle": payload["InnerRef"] = 1; break;
            case "inactiveActualSlot": payload["ActualValueInteger"] = 1; break;
            case "unknownActualType": payload["HasActualValue"] = true; payload["ActualValueType"] = "System.Double"; break;
            case "missingHResult": payload["HasHResult"] = false; break;
            case "invalidParameterPayload": payload["HasParamName"] = false; break;
            case "messageSuffix": payload["Message"] = "missing required suffix"; break;
        }
        var reached = 0;
        call.DataEffect = (_, _) => { reached++; throw new InvalidOperationException("Business data effect reached."); };
        var error = Assert.Throws<ReferenceGraphProbe.Failure>(() => call.Raw(request));
        Assert.Equal("InvalidOperationException", error.Kind); Assert.Equal("Invalid C# reference graph.", error.Message);
        Assert.Equal(0, reached); Assert.Equal(0, call.Field(state, "Visits")); Assert.Null(call.Field(state, "Saved"));
    }

    [Fact]
    public void ValidInputPassesEntryValidationAndReachesTheBusinessDataEffect()
    {
        using var call = new BoundaryCall(GuardSource, "Inspect");
        var request = call.Request(call.New("State"), new ArgumentException("input", "request"));
        var reached = 0;
        call.DataEffect = (_, _) => { reached++; throw new InvalidOperationException("Business data effect reached."); };
        var error = Assert.Throws<InvalidOperationException>(() => call.Raw(request));
        Assert.Equal("Business data effect reached.", error.Message); Assert.Equal(1, reached);
    }

    [Fact]
    public void NonexceptionBoundaryKeepsTheExactVersion2DescriptorAndUnnegotiatedSignature()
    {
        using var call = new BoundaryCall("""
            public sealed class State { public int Visits; }
            public static class Rules { public static State Echo(State state) => state; }
            """, "Echo");
        Assert.Equal(2, call.Abi["version"]!.GetValue<int>());
        Assert.Equal(new[] { "definitions", "id", "inputs", "results", "version" }, call.Abi.Select(p => p.Key).Order(StringComparer.Ordinal));
        var state = call.New("State"); Assert.Same(state, call.Invoke(state));
        Assert.False(call.LastRequest!.ContainsKey("AvGraphAbiIn")); Assert.False(call.LastResponse!.ContainsKey("AvGraphAbiOut"));
        Assert.False(call.LastResponse["AvGraphOut"]!.AsObject().ContainsKey("Exceptions"));
        Assert.True(call.LastResponse.ContainsKey("AvErrors"));
    }

    private const string GuardSource = """
        using Anvil.Authoring;
        using System.ComponentModel.DataAnnotations;
        [Entity] public sealed class Journal { [Key] public int StoredKey { get; set; } public string Text { get; set; } }
        public sealed class State { public int Visits; public Exception? Saved; }
        public static class Rules {
            public static ArgumentException Inspect(IDataSession database, State state, ArgumentException error) {
                state.Visits = database.Query<Journal>().Count();
                state.Saved = error;
                return error;
            }
        }
        """;

    private sealed class BoundaryCall : IDisposable
    {
        private readonly AssemblyLoadContext context = new("exception-boundary-" + Guid.NewGuid(), isCollectible: true);
        private readonly Assembly assembly;
        private readonly ReferenceGraphBinding binding;
        private readonly ReferenceGraphProbe probe;
        private readonly string action;
        internal JsonObject Abi { get; }
        internal JsonObject? LastRequest { get; private set; }
        internal JsonObject? LastResponse { get; private set; }
        internal JsonArray Exceptions => LastResponse!["AvGraphOut"]!["Exceptions"]!.AsArray();
        internal Func<JsonObject, IReadOnlyDictionary<string, object>, Dictionary<string, object>>? DataEffect { set => probe.DataEffect = value; }
        internal BoundaryCall(string source, string method)
        {
            var files = new Dictionary<string, string> { ["ExceptionBoundary.cs"] = source };
            using var stream = new MemoryStream(); var emitted = SourceProgram.Parse(files).Compilation.Emit(stream);
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
            stream.Position = 0; assembly = context.LoadFromStream(stream);
            var compiled = CSharpCompiler.CompileReferenceGraph(files);
            var entry = compiled.SourceAbis!.Select(node => node!.AsObject()).Single(node => node["native"]!.GetValue<string>() == method);
            action = entry["native"]!.GetValue<string>(); Abi = JsonNode.Parse(entry["abi"]!.ToJsonString())!.AsObject();
            // The infrastructure negotiates supported versions; application source never
            // supplies a graph descriptor, codec switch or transport instruction.
            binding = new(Abi, assembly, maxSupportedVersion: 3); probe = new(compiled.Specification);
        }
        internal object New(string name) => Activator.CreateInstance(assembly.GetType(name)!)!;
        internal object? Field(object value, string name) => value.GetType().GetField(name)!.GetValue(value);
        internal object? Invoke(params object?[] arguments) => binding.CreateCall(action).Invoke(arguments, (_, request) => Raw(request));
        internal JsonObject Request(params object?[] arguments)
        {
            var session = binding.CreateSession(); var graph = session.Encode(binding.Inputs, arguments); var wire = binding.CreateWire();
            var roots = wire.EncodeRoots(graph, binding.Inputs); var request = new JsonObject { ["AvGraphIn"] = wire.EncodeArenas(graph) };
            if (binding.AbiVersion == 3) request["AvGraphAbiIn"] = 3;
            for (var index = 0; index < roots.Count; index++) request[binding.InputNames[index]] = roots[index];
            return request;
        }
        internal JsonObject Raw(JsonObject request)
        {
            LastRequest = request.DeepClone().AsObject();
            var response = probe.Run(action, request.ToDictionary(pair => pair.Key, pair => Native(pair.Value), StringComparer.Ordinal));
            return LastResponse = JsonNode.Parse(JsonSerializer.Serialize(response))!.AsObject();
        }
        private static object Native(JsonNode? node) => node switch {
            JsonObject record => record.ToDictionary(pair => pair.Key, pair => Native(pair.Value), StringComparer.Ordinal),
            JsonArray list => list.Select(Native).ToList(),
            JsonValue value when value.TryGetValue<string>(out var text) => text,
            JsonValue value when value.TryGetValue<bool>(out var boolean) => boolean,
            JsonValue value => decimal.Parse(value.ToJsonString(), CultureInfo.InvariantCulture),
            _ => throw new InvalidDataException("Native graph values require explicit presence metadata.")
        };
        public void Dispose() => context.Unload();
    }
}
