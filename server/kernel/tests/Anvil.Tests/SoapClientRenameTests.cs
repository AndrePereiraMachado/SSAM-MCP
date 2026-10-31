using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// F7 (25/10/2026): the owner's first SOAP delivery (SSAMCoverageSoapWire, NumberConversion and CountryInfo, both public)
/// over the candidate the bridge imported (tests/fixtures/soap-wire/import-1.oml, attempt 0 of task 32166633: the Studio's
/// importer named the client "CountryInfo" after the WSDL's service, CountryInfoService, and typed NumberToDollars.dNum,
/// xs:decimal, as Text). The soap op takes the one client of the WSDL with every requested method and the requested name
/// (SOAP_CLIENT_RENAMED, integration.client.renamedFrom), the retyped primitive is a warning of the report, never a refusal,
/// and a method still missing says what happened (no client of the WSDL, or the client without the method), never "deliver
/// it with o11_deliver" to a delivery that was one. The ODC lane answers SOAP_LANE_UNSUPPORTED (SoapLaneOdcTests).
/// </summary>
public class SoapClientRenameTests
{
    private static readonly string Root = JobRunner.RepoRoot(Directory.GetCurrentDirectory())!;
    private static readonly string Imported = Path.Combine(Root, "tests", "fixtures", "soap-wire", "import-1.oml");
    private static string Wsdl(string name) => Path.Combine(Root, "tests", "fixtures", "wsdl", name);

    private static JsonObject Soap(string wsdl, string client, params string[] methods) => new()
    {
        ["op"] = "soap",
        ["data"] = new JsonObject
        {
            ["wsdl"] = new JsonObject { ["path"] = Wsdl(wsdl), ["sha256"] = IntegrationDocuments.Sha256(File.ReadAllBytes(Wsdl(wsdl))) },
            ["client"] = client, ["soapVersion"] = "1.1", ["methods"] = new JsonArray(methods.Select(m => (JsonNode)m).ToArray()),
        },
    };

    // The job of the owner's delivery reduced to its two soap ops (job 8ef5f0c2, ops 1 and 2).
    private static JsonArray OwnerSoapOps() => new(
        Soap("NumberConversion.wso", "NumberConversion", "NumberToWords", "NumberToDollars"),
        Soap("CountryInfoService.wso", "CountryInfo", "ListOfCountryNamesByName", "FullCountryInfo"));

    [Fact]
    public void TheImportedClientTakesTheRequestedNameAndTheRetypedPrimitiveIsAWarning()
    {
        if (!StudioAvailable()) return;
        var (result, error, _) = DeleteBreaksTests.Run(Imported, OwnerSoapOps(), expectValid: true);
        Assert.Null(error);
        var reports = result!["integration"]!.AsArray().OfType<JsonObject>().ToList();
        Assert.Equal(2, reports.Count);
        // CountryInfo: the client the importer named CountryInfoService, renamed before any check.
        var country = reports[1];
        Assert.Equal("CountryInfo", country["client"]!["name"]!.ToString());
        Assert.Equal("CountryInfoService", country["client"]!["renamedFrom"]!.ToString());
        Assert.Equal(["ListOfCountryNamesByName", "FullCountryInfo"], country["skipped"]!.AsArray().Select(s => s!.ToString()));
        var renamed = Assert.Single(result["normalizations"]!.AsArray().OfType<JsonObject>(), n => n["rule"]!.ToString() == "SOAP_CLIENT_RENAMED");
        Assert.Equal("/ops/1/data/client", renamed["path"]!.ToString());
        Assert.Equal("CountryInfoService", renamed["from"]!.ToString());
        Assert.Equal("CountryInfo", renamed["to"]!.ToString());
        // NumberConversion: the importer's own name; dNum (xs:decimal typed Text) is a warning with what it means in a call.
        var numbers = reports[0];
        Assert.Null(numbers["client"]!["renamedFrom"]);
        var warning = Assert.Single(numbers["warnings"]!.AsArray().OfType<JsonObject>());
        Assert.Equal("SOAP_PRIMITIVE_RETYPED", warning["code"]!.ToString());
        Assert.Equal("NumberToDollars", warning["method"]!.ToString());
        Assert.Equal("dNum", warning["parameter"]!.ToString());
        Assert.EndsWith("decimal", warning["wsdlType"]!.ToString());
        Assert.Equal("Decimal", warning["expected"]!.ToString());
        Assert.Equal("Text", warning["studioType"]!.ToString());
        Assert.Contains("DecimalToText", warning["message"]!.ToString());
    }

    [Fact]
    public void AMethodTheImportedClientDoesNotHaveNamesTheClientOfTheWsdlAndRenamesNothing()
    {
        if (!StudioAvailable()) return;
        // CapitalCity is an operation of the port that the import did not bring: the client stays CountryInfoService.
        var (_, error, output) = DeleteBreaksTests.Run(Imported, new JsonArray(Soap("CountryInfoService.wso", "CountryInfo", "CapitalCity")));
        var coded = Errors.FindCoded(error!)!;
        Assert.Equal(IntegrationImport.NeedsStudio, coded.Code);
        var problem = Assert.Single(coded.Problems!)!;
        Assert.Equal("/ops/0/data/client", problem["pointer"]!.ToString());
        Assert.Contains("there is no client 'CountryInfo'", problem["message"]!.ToString());
        Assert.Contains("'CountryInfoService' from this WSDL", problem["message"]!.ToString());
        Assert.Contains("\"client\": \"CountryInfoService\"", problem["fix"]!.ToString());
        Assert.DoesNotContain("deliver it with o11_deliver", problem["fix"]!.ToString());
        Assert.False(File.Exists(output));
    }

    [Fact]
    public void ARequestedClientWithoutTheMethodSaysTheImportRanAndDidNotCreateIt()
    {
        if (!StudioAvailable()) return;
        var (_, error, _) = DeleteBreaksTests.Run(Imported, new JsonArray(Soap("CountryInfoService.wso", "CountryInfoService", "FullCountryInfo", "CapitalCity")));
        var coded = Errors.FindCoded(error!)!;
        Assert.Equal(IntegrationImport.NeedsStudio, coded.Code);
        var problem = Assert.Single(coded.Problems!)!;
        Assert.Contains("client 'CountryInfoService' has no method CapitalCity (its methods: FullCountryInfo, ListOfCountryNamesByName)", problem["message"]!.ToString());
        Assert.Contains("in an o11_deliver the import ran and did not create CapitalCity", problem["fix"]!.ToString());
        Assert.Contains("\"refresh\": [\"CapitalCity\"]", problem["fix"]!.ToString());
    }

    [Fact]
    public void AModuleWithoutAClientOfTheWsdlSaysTheImportDidNotRun()
    {
        if (!StudioAvailable()) return;
        var (_, error, _) = DeleteBreaksTests.Run(null, new JsonArray(Soap("CountryInfoService.wso", "CountryInfo", "FullCountryInfo")));
        var coded = Errors.FindCoded(error!)!;
        Assert.Equal(IntegrationImport.NeedsStudio, coded.Code);
        var problem = Assert.Single(coded.Problems!)!;
        Assert.Contains("the module has no client of this WSDL", problem["message"]!.ToString());
        Assert.Contains("ran without the Studio", problem["fix"]!.ToString());
    }

    private static bool StudioAvailable()
    {
        try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? "") && File.Exists(Imported); } catch { return false; }
    }
}
