using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using System.Runtime.Loader;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Authoring.Transport;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Emit;
using Microsoft.CodeAnalysis.Text;
using Xunit;

namespace Anvil.CSharp.Tests;

public sealed class ExceptionControlPublicCorpusTests
{
    private const string SourceSha256 = "257bbf3e96bb51de3a3a06b30251679e24c0a974d0666cfa1a0973995c78c6f0";
    private const string CasesSha256 = "be98eb5e03a931a907bd15dec384a5273da29cdafa7671d1c7ddaf79e0207c08";
    private const string SourceName = "ExceptionControlFlow.cs";
    private static readonly Lazy<CompiledSource> Corpus = new(() => Compile(Verified("ExceptionControlFlow.cs.txt", SourceSha256), SourceName));
    private static readonly Lazy<string> Reports = new(() => {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null && !File.Exists(Path.Combine(directory.FullName, "MANIFESTO.md"))) directory = directory.Parent;
        var root = directory?.FullName ?? throw new InvalidOperationException("Workspace root not found.");
        var folder = Path.Combine(root, ".local/data-logic-translator/exception-control-public-corpus", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder); return folder;
    });

    public static IEnumerable<object[]> Cases() => JsonNode.Parse(Verified("ExceptionControlFlow.cases.json", CasesSha256))!["cases"]!
        .AsArray().Select(item => new object[] { item!["id"]!.ToString(), item.ToJsonString() });

    [Theory]
    [MemberData(nameof(Cases))]
    public void SharedNativeArenaStorageDoesNotPromoteUnreachableAllocationsToCallerRoots(string id, string serializedCase)
    {
        var test = JsonNode.Parse(serializedCase)!; var expected = test["expected"]!;
        using var fixture = new Calls(Corpus.Value, "CreditRules", shareNativeListStorage: true);
        var state = fixture.New("CreditState"); fixture.Set(state, "Balance", test["input"]!["balance"]!.GetValue<int>());
        var outcome = Observe(() => fixture.Graph(test["method"]!.ToString(), state, test["input"]!["argument"]!.GetValue<int>()));
        var actual = StateResult(fixture, state, outcome);
        foreach (var field in new[] { "returnValue", "balance", "events", "handledOriginalFailure" })
            Assert.True(JsonNode.DeepEquals(expected[field], actual[field]), id + " shared list storage " + field + ": " + actual);
        if (expected["exception"] == null) Assert.Null(outcome.Failure);
        else foreach (var field in new[] { "type", "message", "sameOriginal" })
            Assert.True(JsonNode.DeepEquals(expected["exception"]![field], actual["exception"]![field]), id + " exception " + field + ": " + actual);
        Write(id + "-shared-storage.json", new JsonObject { ["passed"] = true, ["actual"] = actual,
            ["request"] = fixture.LastRequest!.DeepClone(), ["response"] = fixture.LastResponse!.DeepClone(),
            ["scope"] = "Same immutable source/cases, adversarial probe with shared native list storage; native publication proof remains independent." });
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void OriginalCorpusMatchesClrAndSdkAbi3EntryWithStateAndExceptionIdentity(string id, string serializedCase)
    {
        var test = JsonNode.Parse(serializedCase)!; var expected = test["expected"]!;
        using var fixture = new Calls(Corpus.Value, "CreditRules");
        var method = test["method"]!.ToString(); var input = test["input"]!;
        var clrState = fixture.New("CreditState"); var graphState = fixture.New("CreditState");
        fixture.Set(clrState, "Balance", input["balance"]!.GetValue<int>());
        fixture.Set(graphState, "Balance", input["balance"]!.GetValue<int>());
        var clr = Observe(() => fixture.Clr(method, clrState, input["argument"]!.GetValue<int>()));
        var graph = Observe(() => fixture.Graph(method, graphState, input["argument"]!.GetValue<int>()));
        var clrActual = StateResult(fixture, clrState, clr);
        var graphActual = StateResult(fixture, graphState, graph);
        int? clrOriginLine = clr.Failure == null ? null : new StackTrace(clr.Failure, fNeedFileInfo: true).GetFrames()
            .First(frame => frame.GetMethod()?.DeclaringType?.FullName == "CreditRules").GetFileLineNumber();
        var completeClr = clrActual.DeepClone();
        if (completeClr["exception"] is JsonObject clrException) clrException["originLine"] = clrOriginLine;
        Assert.True(JsonNode.DeepEquals(expected, completeClr), id + " CLR expected " + expected + "; actual " + completeClr);
        // The frozen source's physical CLR line is checked above. Generated actions do
        // not execute that CLR frame; no line number is invented for the SDK's stack.
        foreach (var field in new[] { "returnValue", "balance", "events", "handledOriginalFailure" })
            Assert.True(JsonNode.DeepEquals(expected[field], graphActual[field]), id + " field " + field + ": " + graphActual);
        if (expected["exception"] == null) Assert.Null(graph.Failure);
        else
        {
            Assert.NotNull(graph.Failure);
            foreach (var field in new[] { "type", "message", "sameOriginal" })
                Assert.True(JsonNode.DeepEquals(expected["exception"]![field], graphActual["exception"]![field]), id + " exception " + field);
        }
        Assert.True(JsonNode.DeepEquals(clrActual, graphActual), id + " CLR/probe state mismatch: " + graphActual);
        var abi = fixture.LastAbi!;
        Assert.Equal(3, abi["version"]!.GetValue<int>());
        Assert.Equal("Exceptions", abi["exceptionArena"]!.ToString());
        var response = fixture.LastResponse!;
        Assert.Equal(3, response["AvGraphAbiOut"]!.GetValue<int>());
        Assert.False(response.ContainsKey("AvErrors"));
        Assert.Equal(new[] { "ExceptionRef", "Kind" }, response["AvCompletion"]!.AsObject().Select(item => item.Key).Order(StringComparer.Ordinal));
        Assert.Equal(graph.Failure == null ? 1 : 2, response["AvCompletion"]!["Kind"]!.GetValue<int>());
        Assert.Equal(graph.Failure == null, response["AvCompletion"]!["ExceptionRef"]!.GetValue<int>() == 0);
        if (graph.Failure != null && expected["exception"]!["sameOriginal"]!.GetValue<bool>())
            Assert.Same(fixture.Field(graphState, "OriginalFailure"), graph.Failure);
        if (fixture.Field(clrState, "OriginalFailure") is Exception clrOriginal)
        {
            var graphOriginal = Assert.IsAssignableFrom<Exception>(fixture.Field(graphState, "OriginalFailure"));
            Assert.Equal(clrOriginal.GetType(), graphOriginal.GetType()); Assert.Equal(clrOriginal.Message, graphOriginal.Message);
            Assert.Equal(clrOriginal.HResult, graphOriginal.HResult);
        }
        else Assert.Null(fixture.Field(graphState, "OriginalFailure"));
        Write(id + ".json", new JsonObject {
            ["id"] = id, ["sourceSha256"] = SourceSha256, ["casesSha256"] = CasesSha256,
            ["compiledSourceHash"] = Corpus.Value.Compilation.SourceHash,
            ["input"] = input.DeepClone(), ["expectedOriginal"] = expected.DeepClone(),
            ["clr"] = completeClr, ["sdkEntryProbe"] = graphActual, ["protocolPassed"] = true,
            ["abi"] = abi.DeepClone(), ["request"] = fixture.LastRequest!.DeepClone(), ["response"] = response.DeepClone(),
            ["clrOriginLineVerified"] = clrOriginLine, ["graphOriginLineProved"] = false,
            ["scope"] = "Original whole source -> compiler ABI3 -> public generated entry -> emitted-graph copy-semantics probe -> portable SDK caller. Independent CLR checks the complete frozen expectation including physical source line. Graph checks return/state/exception identity, not native execution, physical source origin, Verify, publication or public controller workflow." });
    }

    [Fact]
    public void InputExceptionMatchesCatchEvenWhenItsConcreteTypeIsNeverConstructedInSource()
    {
        const string source = "using System; public static class Rules { public static bool Entry(Exception input) { try { throw input; } catch(FormatException caught) { return ReferenceEquals(caught, input); } catch(Exception) { return false; } } }";
        var compiled = Compile(source, "ImportedException.cs");
        using var fixture = new Calls(compiled, "Rules");
        var original = new FormatException("external original");
        Assert.Equal(true, fixture.Clr("Entry", original)); Assert.Equal(true, fixture.Graph("Entry", original));
        Assert.Equal(3, fixture.LastAbi!["version"]!.GetValue<int>());
        Assert.Equal(0, fixture.LastResponse!["AvCompletion"]!["ExceptionRef"]!.GetValue<int>());
        var returned = Assert.Single(fixture.LastResponse["AvGraphOut"]!["Exceptions"]!.AsArray())!;
        Assert.Equal("System.FormatException", returned["TypeName"]!.ToString());
        Assert.Equal("external original", original.Message);
        Write("input-type-not-constructed.json", new JsonObject { ["passed"] = true, ["source"] = source,
            ["compiledSourceHash"] = compiled.Compilation.SourceHash, ["request"] = fixture.LastRequest!.DeepClone(),
            ["response"] = fixture.LastResponse.DeepClone(), ["scope"] = "CLR and SDK ABI3/generated-entry/probe; no native server execution." });
    }

    private sealed record Outcome(object? Result, Exception? Failure);
    private static Outcome Observe(Func<object?> invoke)
    {
        try { return new(invoke(), null); }
        catch (Exception failure) { return new(null, failure); }
    }
    private static JsonObject StateResult(Calls fixture, object state, Outcome outcome) => new() {
        ["returnValue"] = outcome.Result is int result ? JsonValue.Create(result) : null,
        ["balance"] = (int)fixture.Field(state, "Balance")!,
        ["events"] = JsonSerializer.SerializeToNode((IEnumerable<string>)fixture.Field(state, "Events")!),
        ["handledOriginalFailure"] = (bool)fixture.Field(state, "HandledOriginalFailure")!,
        ["exception"] = outcome.Failure == null ? null : new JsonObject {
            ["type"] = outcome.Failure.GetType().FullName, ["message"] = outcome.Failure.Message,
            ["sameOriginal"] = ReferenceEquals(outcome.Failure, fixture.Field(state, "OriginalFailure")) }
    };

    private sealed record CompiledSource(CompilationResult Compilation, byte[] Assembly, byte[] Symbols);
    private static CompiledSource Compile(string source, string name)
    {
        var syntax = CSharpSyntaxTree.ParseText(SourceText.From(source, Encoding.UTF8), path: name);
        var platform = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator).Select(path => MetadataReference.CreateFromFile(path));
        var clr = CSharpCompilation.Create("ExceptionPublicCorpus", [syntax], platform,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, optimizationLevel: OptimizationLevel.Debug, nullableContextOptions: NullableContextOptions.Enable));
        using var assembly = new MemoryStream(); using var symbols = new MemoryStream();
        var emitted = clr.Emit(assembly, symbols, options: new EmitOptions(debugInformationFormat: DebugInformationFormat.PortablePdb));
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
        var compiled = CSharpCompiler.CompileReferenceGraph(new Dictionary<string, string> { [name] = source });
        Write(name + ".compiled.json", compiled.Specification);
        Write(name + ".source-map.json", compiled.SourceMap);
        Write(name + ".source-abis.json", compiled.SourceAbis!);
        return new(compiled, assembly.ToArray(), symbols.ToArray());
    }

    private sealed class Calls : IDisposable
    {
        private readonly CompiledSource compiled;
        private readonly string rules;
        private readonly AssemblyLoadContext context = new("exception-public-corpus-" + Guid.NewGuid(), isCollectible: true);
        private readonly Assembly assembly;
        private readonly ReferenceGraphProbe probe;
        internal JsonObject? LastAbi { get; private set; }
        internal JsonObject? LastRequest { get; private set; }
        internal JsonObject? LastResponse { get; private set; }
        internal Calls(CompiledSource compiled, string rules, bool shareNativeListStorage = false)
        {
            this.compiled = compiled; this.rules = rules;
            using var bytes = new MemoryStream(compiled.Assembly, writable: false); using var symbols = new MemoryStream(compiled.Symbols, writable: false);
            assembly = context.LoadFromStream(bytes, symbols); probe = new(compiled.Compilation.Specification, shareNativeListStorage);
        }
        internal object New(string type) => Activator.CreateInstance(assembly.GetType(type)!)!;
        internal object? Field(object value, string field) => value.GetType().GetField(field)!.GetValue(value);
        internal void Set(object value, string field, object content) => value.GetType().GetField(field)!.SetValue(value, content);
        internal object? Clr(string method, params object?[] arguments)
        {
            try { return assembly.GetType(rules)!.GetMethod(method)!.Invoke(null, arguments); }
            catch (TargetInvocationException wrapper) when (wrapper.InnerException != null)
            { System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(wrapper.InnerException).Throw(); throw; }
        }
        internal object? Graph(string method, params object?[] arguments)
        {
            var entry = compiled.Compilation.SourceAbis!.Single(item => item!["native"]!.ToString() == method)!;
            LastAbi = entry["abi"]!.DeepClone().AsObject();
            var binding = new ReferenceGraphBinding(LastAbi, assembly, maxSupportedVersion: 3);
            return binding.CreateCall(entry["native"]!.ToString()).Invoke(arguments, (action, request) => {
                LastRequest = request.DeepClone().AsObject();
                LastResponse = JsonSerializer.SerializeToNode(probe.Run(action,
                    request.ToDictionary(item => item.Key, item => Native(item.Value), StringComparer.Ordinal)))!.AsObject();
                return LastResponse;
            });
        }
        private static object Native(JsonNode? node) => node switch {
            JsonObject record => record.ToDictionary(item => item.Key, item => Native(item.Value), StringComparer.Ordinal),
            JsonArray list => list.Select(Native).ToList(),
            JsonValue value when value.TryGetValue<string>(out var text) => text,
            JsonValue value when value.TryGetValue<bool>(out var flag) => flag,
            JsonValue value => decimal.Parse(value.ToJsonString(), CultureInfo.InvariantCulture),
            _ => throw new InvalidDataException("Native payload requires explicit presence metadata.")
        };
        public void Dispose() => context.Unload();
    }

    private static string Verified(string name, string expected)
    {
        var bytes = File.ReadAllBytes(Path.Combine(AppContext.BaseDirectory, "Cases/exception-control-flow", name));
        Assert.Equal(expected, Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant());
        return Encoding.UTF8.GetString(bytes);
    }
    private static void Write(string name, JsonNode value) => File.WriteAllText(Path.Combine(Reports.Value, name), value.ToJsonString());
}
