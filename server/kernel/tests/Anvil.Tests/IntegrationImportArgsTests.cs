using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// The pure part of the O11 bridge verb integration_import (Kernel/IntegrationImport.cs): which imports a job needs and
/// the arguments the bridge refuses before anything runs (a relative path, a sha256 that is not the file's, an out_path
/// that already exists). The bridge answers NotExecuted for any of them: nothing is loaded or written.
/// </summary>
public class IntegrationImportArgsTests
{
    private static readonly string Root = JobRunner.RepoRoot(Directory.GetCurrentDirectory())!;
    private static readonly string Wsdl = Path.Combine(Root, "tests", "fixtures", "wsdl", "calculator-two-ports.wsdl");

    private static (JsonObject Parameters, string Dir) Valid()
    {
        var dir = Path.Combine(Root, ".local", "integration-import-args", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var basePath = Path.Combine(dir, "base.oml");
        File.WriteAllBytes(basePath, [1, 2, 3]);
        return (new JsonObject
        {
            ["module_key"] = "module", ["operation_id"] = Guid.NewGuid().ToString("N"), ["kind"] = "wsdl",
            ["base_path"] = basePath, ["base_sha256"] = IntegrationDocuments.Sha256(File.ReadAllBytes(basePath)),
            ["document_path"] = Wsdl, ["document_sha256"] = IntegrationDocuments.Sha256(File.ReadAllBytes(Wsdl)),
            ["dependencies"] = new JsonArray(), ["client"] = "Calculator", ["out_path"] = Path.Combine(dir, "candidate.oml"),
            ["selection"] = new JsonObject { ["port"] = "CalculatorSoap", ["methods"] = new JsonArray("Add") },
        }, dir);
    }

    [Fact]
    public void AValidRequestPasses()
    {
        var (parameters, _) = Valid();
        Assert.Empty(IntegrationImport.Validate(parameters));
    }

    [Fact]
    public void ARelativePathOrAnotherSha256IsNotExecuted()
    {
        var (relative, _) = Valid();
        relative["document_path"] = "tests/fixtures/wsdl/calculator-two-ports.wsdl";
        Assert.Contains(IntegrationImport.Validate(relative), p => p.Contains("document_path") && p.Contains("absolute"));
        var (changed, _) = Valid();
        changed["base_sha256"] = new string('a', 64);
        Assert.Contains(IntegrationImport.Validate(changed), p => p.Contains("base_path") && p.Contains("has sha256"));
        var (existing, dir) = Valid();
        File.WriteAllText(existing["out_path"]!.ToString(), "x");
        Assert.Contains(IntegrationImport.Validate(existing), p => p.Contains("already exists"));
        var (all, _) = Valid();
        all["kind"] = "zip"; all["client"] = "1x"; all["out_path"] = "candidate.oml"; all.Remove("module_key");
        Assert.True(IntegrationImport.Validate(all).Count >= 4, string.Join(" | ", IntegrationImport.Validate(all)));
        Assert.True(Directory.Exists(dir));
    }

    [Fact]
    public void AJobNeedsOneImportPerSoapOpAndPerO11OpenApiOp()
    {
        var ops = JsonNode.Parse($$$"""
        [{"op":"soap","data":{"wsdl":{"path":{{{System.Text.Json.JsonSerializer.Serialize(Wsdl)}}}},"port":"CalculatorSoap","methods":["Add"],"refresh":["Subtract"]}},
         {"op":"rest","data":{"client":{"name":"Plain","baseUrl":"https://example.invalid"},"methods":[{"name":"Get","http":"GET","path":"/x"}]}}]
        """)!.AsArray();
        var request = Assert.Single(IntegrationImport.Requests(ops));
        Assert.Equal(0, request.Op);
        Assert.Equal("wsdl", request.Kind);
        Assert.Equal("Calculator", request.Parameters["client"]!.ToString());
        Assert.Equal("CalculatorSoap", request.Parameters["selection"]!["port"]!.ToString());
        Assert.Equal(["Add", "Subtract"], request.Parameters["selection"]!["methods"]!.AsArray().Select(m => m!.ToString()));
        Assert.Equal(IntegrationDocuments.Sha256(File.ReadAllBytes(Wsdl)), request.Parameters["document_sha256"]!.ToString());
        Assert.Equal(IntegrationImport.WsdlCapability, IntegrationImport.CapabilityOf("wsdl"));
    }
}
