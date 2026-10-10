using System.Globalization;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Authoring.Transport;
using Xunit;

namespace Anvil.CSharp.Tests;

// Staged compiler -> SDK -> emitted entry/probe, plus independently constructed
// peer records. No automatic profile selection or native runtime is required.
public class Abi2ExceptionCompatibilityTests
{
    [Theory]
    [InlineData("Exception")]
    [InlineData("InvalidOperationException")]
    [InlineData("NullReferenceException")]
    [InlineData("IndexOutOfRangeException")]
    [InlineData("DivideByZeroException")]
    [InlineData("OverflowException")]
    [InlineData("NotSupportedException")]
    public void SevenCompactAbi2TypesStillWriteBackBeforeThrow(string type)
    {
        var expected = (Exception)Activator.CreateInstance(typeof(Exception).Assembly.GetType("System." + type)!, "legacy")!;
        var errors = new JsonArray(new JsonObject {
            ["TypeName"] = expected.GetType().FullName, ["Message"] = expected.Message, ["InnerRef"] = 0 });
        var input = new[] { 7 };
        SameException(expected, CodecFailure(input, errors));
        Assert.Equal(99, input[0]);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(5)]
    [InlineData(6)]
    [InlineData(7)]
    [InlineData(8)]
    public void TypedArgumentPayloadPreservesFieldsSuffixAndInnerBeforeThrow(int scenario)
    {
        Exception expected = scenario switch {
            0 => new ArgumentException("missing"),
            1 => new ArgumentException("bad", ""),
            2 => new ArgumentNullException("value", "missing"),
            3 => new ArgumentOutOfRangeException("count", 123, "bad"),
            4 => new ArgumentOutOfRangeException("count", long.MaxValue, "bad"),
            5 => new ArgumentOutOfRangeException("value", true, "bad"),
            6 => new ArgumentOutOfRangeException("value", "text", "bad"),
            7 => new ArgumentException("outer (Parameter 'p')", "p", new InvalidOperationException("inner")),
            8 => new ArgumentNullException("outer", new InvalidOperationException("inner")),
            _ => throw new ArgumentOutOfRangeException(nameof(scenario))
        };
        var input = new[] { 7 };
        SameException(expected, CodecFailure(input, TypedChain(expected)));
        Assert.Equal(99, input[0]);
    }

    public static IEnumerable<object[]> MalformedPayloads()
    {
        foreach (var version in new[] { 2, 3, 4 })
        foreach (var malformed in new[] { "presence", "hresult", "actual-tag", "inactive-slot", "null-field", "message-suffix",
            "unknown-field", "inner-link", "compact-argument", "wrong-actual-owner", "unknown-type", "null-message",
            "wrong-message", "null-type", "wrong-type", "null-inner", "wrong-inner" })
            yield return new object[] { version, malformed };
    }

    [Theory]
    [MemberData(nameof(MalformedPayloads))]
    public void InvalidTypedPayloadFailsBeforeCallerWritebackInEveryAbi(int version, string malformed)
    {
        var errors = TypedChain(new ArgumentOutOfRangeException("count", 123, "bad"));
        var record = errors[0]!.AsObject();
        switch (malformed)
        {
            case "presence": record["HasParamName"] = false; break;
            case "hresult": record["HResult"] = 1; break;
            case "actual-tag": record["HasActualValue"] = false; break;
            case "inactive-slot": record["ActualValueLong"] = 1L; break;
            case "null-field": record["ParamName"] = null; break;
            case "message-suffix": record["Message"] = "different"; break;
            case "unknown-field": record["Unknown"] = 0; break;
            case "inner-link": record["InnerRef"] = 1; break;
            case "compact-argument": errors = new JsonArray(new JsonObject {
                ["TypeName"] = "System.ArgumentException", ["Message"] = "bad", ["InnerRef"] = 0 }); break;
            case "wrong-actual-owner": record["TypeName"] = "System.ArgumentException"; break;
            case "unknown-type": record["TypeName"] = "System.IO.IOException"; break;
            case "null-message": record["Message"] = null; break;
            case "wrong-message": record["Message"] = 12; break;
            case "null-type": record["TypeName"] = null; break;
            case "wrong-type": record["TypeName"] = 12; break;
            case "null-inner": record["InnerRef"] = null; break;
            case "wrong-inner": record["InnerRef"] = "0"; break;
            default: throw new ArgumentOutOfRangeException(nameof(malformed));
        }
        var input = new[] { 7 };
        Assert.IsType<InvalidDataException>(CodecFailure(input, errors, version));
        Assert.Equal(7, input[0]);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public void OriginalCorpusFailuresRetainTheirClrExceptionThroughAbi2(int scenario)
    {
        var (file, owner, method, arguments) = scenario switch {
            0 => ("NullableMembers.cs.txt", "NullableMembers", "Guarded", new object?[] { null }),
            1 => ("LogicBasics.cs.txt", "Rules", "MakeQuote", new object?[] { 0, 3m, 1m }),
            2 => ("LogicBasics.cs.txt", "Rules", "MakeQuote", new object?[] { 1, -1m, 1m }),
            3 => ("LogicBasics.cs.txt", "Rules", "MakeQuote", new object?[] { 1, 1m, -1m }),
            _ => throw new ArgumentOutOfRangeException(nameof(scenario))
        };
        var source = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Cases", file));
        SourceFailure(source, owner, method, "Rules.cs", arguments, arguments, 2);
    }

    [Theory]
    [InlineData("SystemException")]
    [InlineData("ApplicationException")]
    [InlineData("InvalidCastException")]
    [InlineData("FormatException")]
    public void AdditionalBclTypesPreserveInnerExceptionAndSourceMutationInAbi2(string type)
    {
        var source = "public static class Rules { public static int[] Run(int[] values) { values[0] = 99; throw new " + type
            + "(\"observed \" + values[0], new ArgumentException(\"inner\", \"values\")); } }";
        var clrInput = new[] { 7 }; var sdkInput = new[] { 7 };
        SourceFailure(source, "Rules", "Run", "Rules.cs", [clrInput], [sdkInput], 2);
        Assert.Equal(99, clrInput[0]); Assert.Equal(99, sdkInput[0]);
    }

    [Theory]
    [InlineData(3)]
    [InlineData(4)]
    public void SourceRethrowKeepsOriginalExceptionIdentityInAbi3And4(int version)
    {
        var source = version == 3 ? "public static class Rules { public static int Run(Exception error) { throw error; } }"
            : "public static class Rules { public static DateOnly Run(Exception error) { throw error; } }";
        var expected = new ArgumentException("outer", "input", new InvalidOperationException("inner"));
        var actual = SourceFailure(source, "Rules", "Run", "Compatibility.cs", [expected], [expected], version);
        Assert.Same(expected, actual);
    }

    private static Exception SourceFailure(string source, string owner, string methodName, string file,
        object?[] clrArguments, object?[] sdkArguments, int version)
    {
        var files = new Dictionary<string, string> { [file] = source };
        var context = new AssemblyLoadContext("abi2-exception-" + Guid.NewGuid(), isCollectible: true);
        try
        {
            using var bytes = new MemoryStream(); var emitted = SourceProgram.Parse(files).Compilation.Emit(bytes);
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
            bytes.Position = 0; var assembly = context.LoadFromStream(bytes);
            var method = assembly.GetType(owner)!.GetMethod(methodName)!;
            var compiled = CSharpCompiler.CompileReferenceGraph(files);
            var schema = compiled.SourceAbis!.Single(item => item!["native"]!.ToString() == methodName)!["abi"]!.AsObject();
            var binding = new ReferenceGraphBinding(schema, assembly, maxSupportedVersion: 4);
            Assert.Equal(version, binding.AbiVersion);
            var probe = new ReferenceGraphProbe(compiled.Specification);
            var expected = Failure(() => method.Invoke(null, clrArguments));
            var actual = Failure(() => binding.CreateCall(methodName).Invoke(sdkArguments, (action, request) =>
                JsonSerializer.SerializeToNode(probe.Run(action, request.ToDictionary(pair => pair.Key, pair => Native(pair.Value))))!.AsObject()));
            SameException(expected, actual);
            return actual!;
        }
        finally { context.Unload(); }
    }

    private static Exception? CodecFailure(int[] input, JsonArray errors, int version = 2)
    {
        GraphDefinition[] definitions = [new("Arrays", typeof(int[]), [], new GraphScalar(typeof(int)))];
        var call = new ReferenceGraphCall("Fail", ["Arg_input"], [new GraphReference("Arrays")], [], definitions, version);
        return Failure(() => call.Invoke([input], (_, request) => {
            var graph = request["AvGraphIn"]!.DeepClone(); graph["Arrays"]![0]!["Items"]![0] = 99;
            if (version >= 3)
            {
                graph["Exceptions"] = errors.DeepClone();
                return new JsonObject { ["AvGraphAbiOut"] = version, ["AvGraphOut"] = graph,
                    ["AvCompletion"] = new JsonObject { ["Kind"] = 2, ["ExceptionRef"] = 1 } };
            }
            return new JsonObject { ["AvGraphOut"] = graph, ["AvCompletion"] = new JsonObject { ["Kind"] = 2, ["ExceptionRef"] = 1 },
                ["AvErrors"] = errors.DeepClone() };
        }));
    }

    private static JsonArray TypedChain(Exception root)
    {
        var result = new JsonArray();
        for (Exception? error = root; error != null; error = error.InnerException)
        {
            var actual = (error as ArgumentOutOfRangeException)?.ActualValue;
            var paramName = (error as ArgumentException)?.ParamName;
            result.Add(new JsonObject {
                ["TypeName"] = error.GetType().FullName, ["Message"] = error.Message,
                ["ParamName"] = paramName ?? "", ["HasParamName"] = paramName != null,
                ["InnerRef"] = error.InnerException == null ? 0 : result.Count + 2,
                ["HasHResult"] = true, ["HResult"] = error.HResult,
                ["HasActualValue"] = actual != null, ["ActualValueType"] = actual?.GetType().FullName ?? "",
                ["ActualValueInteger"] = actual is int integer ? integer : 0, ["ActualValueLong"] = actual is long number ? number : 0L,
                ["ActualValueText"] = actual as string ?? "", ["ActualValueBoolean"] = actual is bool boolean && boolean
            });
        }
        return result;
    }

    private static void SameException(Exception? expected, Exception? actual)
    {
        Assert.NotNull(expected); Assert.NotNull(actual);
        Assert.Equal(expected.GetType(), actual.GetType()); Assert.Equal(expected.Message, actual.Message);
        Assert.Equal(expected.HResult, actual.HResult);
        if (expected is ArgumentException argument) Assert.Equal(argument.ParamName, ((ArgumentException)actual).ParamName);
        if (expected is ArgumentOutOfRangeException range) Assert.Equal(range.ActualValue, ((ArgumentOutOfRangeException)actual).ActualValue);
        if (expected.InnerException == null) Assert.Null(actual.InnerException);
        else SameException(expected.InnerException, actual.InnerException);
    }

    private static Exception? Failure(Action action)
    {
        var error = Record.Exception(action);
        while (error is TargetInvocationException { InnerException: not null } nested) error = nested.InnerException;
        return error;
    }

    private static object Native(JsonNode? node) => node switch {
        JsonObject record => record.ToDictionary(pair => pair.Key, pair => Native(pair.Value)),
        JsonArray array => array.Select(Native).ToList(),
        JsonValue value when value.TryGetValue<string>(out var text) => text,
        JsonValue value when value.TryGetValue<bool>(out var flag) => flag,
        JsonValue value => decimal.Parse(value.ToJsonString(), CultureInfo.InvariantCulture),
        _ => throw new InvalidDataException("Native graph payloads use explicit presence.")
    };
}
