using System.Reflection;
using System.Runtime.Loader;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Xunit;

namespace Anvil.CSharp.Tests;

/// <summary>The immutable cold corpus is consumed as written. The graph probe copies
/// native values at every assignment/call; only explicit arena identities can alias.</summary>
public class ColdReferenceJournalTests
{
    private static readonly Lazy<string> Source = new(() => Verified("ColdReferenceJournal.cs.txt", "80292620b436d7cbc08257ae468a9faef7c27dc4960b5d5456854314d2590b11"));
    private static readonly Lazy<CompilationResult> Compiled = new(() => CSharpCompiler.Compile(new Dictionary<string, string> { ["ColdReferenceJournal.cs"] = Source.Value }));
    private static string Verified(string relative, string hash)
    {
        var bytes = File.ReadAllBytes(Path.Combine(AppContext.BaseDirectory, "Cases", relative));
        Assert.Equal(hash, Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant());
        return System.Text.Encoding.UTF8.GetString(bytes).TrimStart('\uFEFF');
    }
    public static IEnumerable<object[]> Cases()
    {
        Verified("oracles/ColdReferenceJournal/inputs.json", "763317e36be6aa443155d7197faa46ff7d397ea3c0fb5105ada45593ffd72e3f");
        var oracle = JsonNode.Parse(Verified("oracles/ColdReferenceJournal/expected.json", "a0ffc6a828cf54ddbe41806cc9942ab2dd2b8484c31090964c22d73cca39536f"))!;
        return oracle["cases"]!.AsArray().Select(c => new object[] { c!["id"]!.ToString(), c.ToJsonString() });
    }
    [Theory]
    [MemberData(nameof(Cases))]
    public void IntactColdCaseMatchesClrAndGeneratedContext(string id, string json)
    {
        _ = id;
        var test = JsonNode.Parse(json)!;
        using var oracle = new Oracle(Source.Value);
        var method = oracle.Type.GetMethod(test["method"]!.ToString())!;
        var parameters = method.GetParameters();
        var arguments = test["arguments"]!.AsArray().Select((v, i) => ClrArgument(v, parameters[i].ParameterType)).ToArray();
        object? value = null; Exception? failure = null;
        try { value = method.Invoke(null, arguments); }
        catch (TargetInvocationException exception) { failure = exception.InnerException; }
        var expected = test["expected"]!;
        if (failure == null) Assert.Equal(expected["value"]?.GetValue<string>(), value);
        else
        {
            Assert.Equal("throw", expected["kind"]!.ToString());
            Assert.Equal(expected["exception"]!["type"]!.ToString(), failure.GetType().FullName);
            Assert.Equal(expected["exception"]!["message"]!.ToString(), failure.Message);
            Assert.Equal(expected["exception"]!["hResult"]!.GetValue<int>(), failure.HResult);
        }
        var compiled = Compiled.Value;
        var map = compiled.SourceMap.OfType<JsonObject>().Single(m => m["source"]?.ToString().StartsWith("ColdReferenceJournal." + method.Name + "(", StringComparison.Ordinal) == true);
        var inputs = parameters.Select((p, i) => (Name: "Arg_" + p.Name, Value: NativeArgument(arguments[i], p.ParameterType))).ToDictionary(p => p.Name, p => p.Value);
        var probe = new ReferenceGraphProbe(compiled.Specification);
        var output = probe.Run(map["implementation"]!.ToString(), inputs);
        var completion = Fields(output["AvCompletion"]);
        if (failure == null)
        {
            Assert.NotEqual(2m, completion["Kind"]);
            Assert.Equal(value, Text(output["AvResult"]));
            Assert.Equal(value, Text(probe.Run(map["native"]!.ToString(), inputs)["AvResult"]));
        }
        else
        {
            Assert.Equal(2m, completion["Kind"]);
            var exceptions = (List<object>)Fields(output["AvContextOut"])["Exceptions"];
            var exception = Fields(exceptions[(int)(decimal)completion["ExceptionRef"] - 1]);
            Assert.Equal(failure.GetType().FullName, exception["TypeName"]);
            Assert.Equal(failure.Message, exception["Message"]);
            Assert.True((bool)exception["HasHResult"]);
            Assert.Equal((decimal)failure.HResult, exception["HResult"]);
            Assert.Equal(failure is ArgumentException { ParamName: not null }, exception["HasParamName"]);
            if (failure is ArgumentException argumentException) Assert.Equal(argumentException.ParamName, exception["ParamName"]);
            Assert.Equal(failure is ArgumentOutOfRangeException { ActualValue: not null }, exception["HasActualValue"]);
            if (failure is ArgumentOutOfRangeException outOfRange)
            {
                Assert.Equal("System.Int32", exception["ActualValueType"]);
                Assert.Equal(Convert.ToDecimal(outOfRange.ActualValue), exception["ActualValueInteger"]);
            }
            Assert.Equal(0m, exception["InnerRef"]);
            var boundary = Assert.Throws<ReferenceGraphProbe.Failure>(() => probe.Run(map["native"]!.ToString(), inputs));
            Assert.Equal(failure.GetType().Name, boundary.Kind); Assert.Equal(failure.Message, boundary.Message);
        }
        // Source/TargetSite/CLR stack text and exception object boundary codecs are not represented.
    }
    private static object? ClrArgument(JsonNode? value, Type type) => value == null ? null : type == typeof(string) ? value.GetValue<string>() : type == typeof(bool) ? value.GetValue<bool>() : value.GetValue<int>();
    private static object NativeArgument(object? value, Type type) => type == typeof(string)
        ? new Dictionary<string, object> { ["HasValue"] = value != null, ["Value"] = value ?? "" }
        : value is int number ? (decimal)number : value!;
    private static object? Text(object value) => (bool)Fields(value)["HasValue"] ? Fields(value)["Value"] : null;
    private static Dictionary<string, object> Fields(object value) => Assert.IsType<Dictionary<string, object>>(value);
    private sealed class Oracle : IDisposable
    {
        private readonly AssemblyLoadContext context = new("cold-reference-fields-" + Guid.NewGuid(), isCollectible: true);
        public Type Type { get; }
        public Oracle(string source)
        {
            using var stream = new MemoryStream();
            var result = SourceProgram.Parse(new Dictionary<string, string> { ["ColdReferenceJournal.cs"] = source }).Compilation.Emit(stream);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics)); stream.Position = 0;
            Type = context.LoadFromStream(stream).GetType("ColdReferenceJournal")!;
        }
        public void Dispose() => context.Unload();
    }
}
