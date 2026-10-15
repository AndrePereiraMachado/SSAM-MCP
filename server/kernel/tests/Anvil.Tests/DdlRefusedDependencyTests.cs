using System.Reflection;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

public sealed class DdlRefusedDependencyTests
{
    private const string Broken = "nonsense declaration;\ntype DeclaredAfterError = { Value: Integer; }\n";

    [Fact]
    public void MalformedDataKeepsEverySuccessfullyReadDeclaration()
    {
        var error = Assert.Throws<DdlParseException>(() => DdlParser.Parse(Broken, "o11"));
        Assert.NotNull(error.Partial);
        Assert.Contains(error.Partial.All(), e => e.Name == "DeclaredAfterError");
        var data = new JsonObject { ["ddl"] = Broken };
        Assert.Contains("DeclaredAfterError", SpecExpander.DdlNames(data));
    }

    [Theory]
    [InlineData("unknown type: DeclaredAfterError")]
    [InlineData("unknown type 'DeclaredAfterError'")]
    [InlineData("unknown type: 'DeclaredAfterError'")]
    public void MissingTypesAreRecognizedAsDependencies(string message)
    {
        var blocked = typeof(ModelSession).GetNestedType("Blocked", BindingFlags.NonPublic)!;
        var method = blocked.GetMethod("MissingName", BindingFlags.Public | BindingFlags.Static)!;
        Assert.Equal("DeclaredAfterError", method.Invoke(null, [new InvalidOperationException(message), message]));
    }

    [Fact]
    public void LogicUsingATypeFromRefusedDataIsSkipped()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Path.Combine(PacoteBPolicyTests.FindRoot(), ".local", "refused-dependency-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var job = new JsonObject
        {
            ["base"] = "blank-service.oml",
            ["ops"] = new JsonArray(
                new JsonObject { ["op"] = "spec", ["data"] = new JsonObject { ["ddl"] = Broken } },
                new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["actions"] = new JsonArray(
                    new JsonObject { ["name"] = "ConsumeDeclaredType", ["inputs"] = new JsonArray(new JsonObject { ["name"] = "Record", ["type"] = "DeclaredAfterError" }), ["steps"] = new JsonArray() }) } })
        };
        var path = Path.Combine(dir, "job.json");
        File.WriteAllText(path, job.ToJsonString());
        var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, path, Path.Combine(dir, "out.oml")));
        var refusal = Assert.IsType<JobPreflightException>(Errors.FindCoded(error));
        Assert.Contains(refusal.Problems, p => p!["code"]!.ToString() == "DDL_SYNTAX");
        Assert.DoesNotContain(refusal.Problems, p => p!["code"]!.ToString() is "TYPE_UNRESOLVED" or "REFERENCE_UNRESOLVED");
        Assert.Contains(refusal.Warnings, p => p!["code"]!.ToString() == "APPLY_SKIPPED");
    }
}
