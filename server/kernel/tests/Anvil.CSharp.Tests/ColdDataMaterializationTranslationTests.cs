using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Anvil.CSharp.Tests;

/// <summary>Compilation coverage for the unchanged cold source. Exported native
/// inputs are not a claim of generated-graph, database or Studio execution.</summary>
public class ColdDataMaterializationTranslationTests
{
    private const string SourceHash = "f927a785a9be46f768bc0fd9820e9be94bf9589ad926b55fc5dc77feabe17cfc";
    private const string SourceFile = "ColdDataMaterialization.cs";
    private const string RulesType = "ColdDataMaterialization.Rules";

    [Fact]
    public void NullableValueCaptureStillRejectsMovingItsExceptionOutsideQueryEnumeration()
    {
        var source = "using Anvil.Authoring; [Entity] public sealed record Row(long Id, int Quantity); public static class Rules { public static int Count(IDataSession db, int? threshold) => db.Query<Row>().Count(row => row.Quantity == threshold.Value); }";
        var error = Assert.Throws<SourceCompilationException>(() => CSharpCompiler.CompileReferenceGraph(new Dictionary<string, string> { ["NullableCapture.cs"] = source }));
        Assert.Contains(error.Diagnostics, diagnostic => diagnostic.Code == "AVCS310" && diagnostic.Message.Contains("Captured query effects", StringComparison.Ordinal));
    }

    [Fact]
    public void UnchangedColdSourceCompilesAllPublicRulesAndExportsNativeInputs()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "Cases", "cold-data-materialization", "ColdDataMaterialization.cs.txt");
        var bytes = File.ReadAllBytes(path);
        Assert.Equal(SourceHash, Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant());
        var source = System.Text.Encoding.UTF8.GetString(bytes).TrimStart('\uFEFF');
        var files = new Dictionary<string, string> { [SourceFile] = source };
        var program = SourceProgram.Parse(files);
        var methods = program.Types.Single(type => type.ToDisplayString() == RulesType).GetMembers().OfType<IMethodSymbol>()
            .Where(method => method.MethodKind == MethodKind.Ordinary && method.IsStatic && method.DeclaredAccessibility == Accessibility.Public)
            .Select(method => method.ToDisplayString()).OrderBy(name => name, StringComparer.Ordinal).ToArray();
        Assert.Equal(13, methods.Length);

        var folder = Path.Combine(WorkspaceRoot(), ".local", "data-logic-translator", "cold-data-native-input");
        Directory.CreateDirectory(folder);
        File.WriteAllBytes(Path.Combine(folder, "source.cs"), bytes);
        File.WriteAllText(Path.Combine(folder, "source-bytes-sha256.txt"), SourceHash);
        CompilationResult compiled;
        try { compiled = CSharpCompiler.CompileReferenceGraph(files); }
        catch (SourceCompilationException error)
        {
            File.WriteAllText(Path.Combine(folder, "compilation-result.json"), JsonSerializer.Serialize(new
            {
                passed = false,
                sourceSha256 = SourceHash,
                sourceFile = SourceFile,
                scope = "reference-graph compilation only; no generated/native/database execution",
                diagnostics = error.Diagnostics
            }, new JsonSerializerOptions { WriteIndented = true }));
            throw;
        }

        var mapped = compiled.SourceMap.OfType<JsonObject>()
            .Where(entry => entry["source"]?.ToString().StartsWith(RulesType + ".", StringComparison.Ordinal) == true
                && entry["kind"]?.ToString() is "server" or "service")
            .OrderBy(entry => entry["source"]!.ToString(), StringComparer.Ordinal).ToArray();
        Assert.Equal(13, mapped.Length);
        Assert.Equal(methods, mapped.Select(entry => entry["source"]!.ToString()));
        var actions = compiled.Specification["logic"]!["actions"]!.AsArray().OfType<JsonObject>().ToArray();
        foreach (var entry in mapped)
        {
            var action = Assert.Single(actions, action => action["name"]!.ToString() == entry["native"]!.ToString());
            Assert.True(action["public"]!.GetValue<bool>());
        }

        File.WriteAllText(Path.Combine(folder, "contract.json"), compiled.Specification.ToJsonString());
        File.WriteAllText(Path.Combine(folder, "source-map.json"), compiled.SourceMap.ToJsonString());
        File.WriteAllText(Path.Combine(folder, "source-abis.json"), (compiled.SourceAbis ?? new JsonArray()).ToJsonString());
        File.WriteAllText(Path.Combine(folder, "required-intrinsics.json"), JsonSerializer.Serialize(compiled.RequiredIntrinsics ?? []));
        File.WriteAllText(Path.Combine(folder, "source-hash.txt"), compiled.SourceHash);
        File.WriteAllText(Path.Combine(folder, "compilation-result.json"), JsonSerializer.Serialize(new
        {
            passed = true,
            sourceSha256 = SourceHash,
            sourceBundleHash = compiled.SourceHash,
            sourceFile = SourceFile,
            scope = "reference-graph compilation only; no generated/native/database execution",
            publicSourceMethods = mapped.Length,
            generatedActions = actions.Length,
            sourceAbis = compiled.SourceAbis?.Count ?? 0,
            requiredIntrinsics = compiled.RequiredIntrinsics?.Count ?? 0,
            methods = mapped.Select(entry => new { source = entry["source"]!.ToString(), native = entry["native"]!.ToString() }).ToArray()
        }, new JsonSerializerOptions { WriteIndented = true }));
        Assert.Equal(bytes, File.ReadAllBytes(path));
        Assert.Equal(bytes, File.ReadAllBytes(Path.Combine(folder, "source.cs")));
    }

    private static string WorkspaceRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null && !File.Exists(Path.Combine(directory.FullName, "MANIFESTO.md"))) directory = directory.Parent;
        return directory?.FullName ?? throw new InvalidOperationException("Anvil workspace root was not found.");
    }
}
