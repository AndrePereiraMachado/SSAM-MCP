using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Loader;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Emit;
using Microsoft.CodeAnalysis.Text;
using Xunit;

namespace Anvil.CSharp.Tests;

/// <summary>
/// Independent CLR source contract, authored and frozen before the first execution.
/// Compiles directly with Roslyn; never invokes the Anvil parser, translator, or native runtime.
/// </summary>
public class ExceptionControlFlowSourceTests
{
    private const string SourceHash = "257bbf3e96bb51de3a3a06b30251679e24c0a974d0666cfa1a0973995c78c6f0";
    private const string CasesHash = "be98eb5e03a931a907bd15dec384a5273da29cdafa7671d1c7ddaf79e0207c08";
    private const string SourceName = "ExceptionControlFlow.cs";
    private const string Scope = "Independent CLR source semantics only; no translator, native graph, O11 Verify, Studio, persistence, product integration, or public workflow proof.";
    private static readonly Lazy<(byte[] Assembly, byte[] Symbols)> Compiled = new(CompileSource);

    public static IEnumerable<object[]> Cases()
    {
        var contract = JsonNode.Parse(Verified("ExceptionControlFlow.cases.json", CasesHash))!;
        return contract["cases"]!.AsArray().Select(item => new object[]
        {
            item!["id"]!.GetValue<string>(), item.ToJsonString()
        });
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void FrozenBusinessRulesMatchClr(string id, string serializedCase)
    {
        var test = JsonNode.Parse(serializedCase)!;
        var context = new AssemblyLoadContext("exception-source-" + Guid.NewGuid(), isCollectible: true);
        try
        {
            using var assemblyStream = new MemoryStream(Compiled.Value.Assembly, writable: false);
            using var symbolStream = new MemoryStream(Compiled.Value.Symbols, writable: false);
            var assembly = context.LoadFromStream(assemblyStream, symbolStream);
            var stateType = assembly.GetType("CreditState", throwOnError: true)!;
            var state = Activator.CreateInstance(stateType)!;
            stateType.GetField("Balance")!.SetValue(state, test["input"]!["balance"]!.GetValue<int>());
            var rules = assembly.GetType("CreditRules", throwOnError: true)!;
            var method = rules.GetMethod(test["method"]!.GetValue<string>(), BindingFlags.Public | BindingFlags.Static)!;
            object? returnValue = null;
            Exception? failure = null;
            try
            {
                returnValue = method.Invoke(null, new object[] { state, test["input"]!["argument"]!.GetValue<int>() });
            }
            catch (TargetInvocationException wrapper) when (wrapper.InnerException != null)
            {
                failure = wrapper.InnerException;
            }

            var originalFailure = stateType.GetField("OriginalFailure")!.GetValue(state);
            var actual = new JsonObject
            {
                ["returnValue"] = returnValue is int number ? JsonValue.Create(number) : null,
                ["balance"] = (int)stateType.GetField("Balance")!.GetValue(state)!,
                ["events"] = JsonSerializer.SerializeToNode((IEnumerable<string>)stateType.GetField("Events")!.GetValue(state)!),
                ["handledOriginalFailure"] = (bool)stateType.GetField("HandledOriginalFailure")!.GetValue(state)!,
                ["exception"] = failure == null ? null : new JsonObject
                {
                    ["type"] = failure.GetType().FullName,
                    ["message"] = failure.Message,
                    ["sameOriginal"] = ReferenceEquals(failure, originalFailure),
                    ["originLine"] = new StackTrace(failure, fNeedFileInfo: true).GetFrames()
                        .First(frame => frame.GetMethod()?.DeclaringType == rules).GetFileLineNumber()
                }
            };
            var expected = test["expected"]!;
            var passed = JsonNode.DeepEquals(expected, actual);
            var receipt = new JsonObject
            {
                ["id"] = id,
                ["recordedUtc"] = DateTimeOffset.UtcNow.ToString("O"),
                ["runtime"] = RuntimeInformation.FrameworkDescription,
                ["sourceSha256"] = SourceHash,
                ["casesSha256"] = CasesHash,
                ["input"] = test["input"]!.DeepClone(),
                ["expected"] = expected.DeepClone(),
                ["actual"] = actual.DeepClone(),
                ["passed"] = passed,
                ["scope"] = Scope
            };
            Directory.CreateDirectory(ReportsDirectory);
            File.WriteAllText(Path.Combine(ReportsDirectory, id + ".json"),
                receipt.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
            Assert.True(passed, $"{id}: expected {expected}; actual {actual}");
        }
        finally
        {
            context.Unload();
        }
    }

    private static (byte[] Assembly, byte[] Symbols) CompileSource()
    {
        var source = Verified("ExceptionControlFlow.cs.txt", SourceHash);
        var syntax = CSharpSyntaxTree.ParseText(SourceText.From(source, Encoding.UTF8), path: SourceName);
        var platformAssemblies = (string?)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")
            ?? throw new InvalidOperationException("CLR platform assembly references are unavailable.");
        var references = platformAssemblies.Split(Path.PathSeparator)
            .Select(path => MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create("IndependentExceptionControlFlow", new[] { syntax }, references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary,
                optimizationLevel: OptimizationLevel.Debug, nullableContextOptions: NullableContextOptions.Enable));
        using var assembly = new MemoryStream();
        using var symbols = new MemoryStream();
        var emitted = compilation.Emit(assembly, symbols,
            options: new EmitOptions(debugInformationFormat: DebugInformationFormat.PortablePdb));
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
        return (assembly.ToArray(), symbols.ToArray());
    }

    private static string Verified(string name, string expectedHash)
    {
        var path = Path.Combine(AppContext.BaseDirectory, "Cases", "exception-control-flow", name);
        var bytes = File.ReadAllBytes(path);
        Assert.Equal(expectedHash, Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant());
        return Encoding.UTF8.GetString(bytes);
    }

    private static string ReportsDirectory
    {
        get
        {
            var directory = new DirectoryInfo(AppContext.BaseDirectory);
            while (directory != null && !File.Exists(Path.Combine(directory.FullName, "MANIFESTO.md")))
                directory = directory.Parent;
            var root = directory?.FullName ?? throw new InvalidOperationException("Anvil workspace root was not found.");
            return Path.Combine(root, ".local", "data-logic-translator", "exception-source-contract", "receipts");
        }
    }
}
