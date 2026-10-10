using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// The headless pre-check of the op `soap` (SoapPlan): synthetic WSDLs only, no Studio, no network. The rules are the
/// behavior GitSSAM proved live (a single SOAP 1.1 port wins, the binding resolves to its port, every selector and method
/// is refused before any change with every choice listed, DTD/ENTITY refused, the pinned bytes are the ones planned).
/// </summary>
public class SoapPlanTests
{
    private static readonly string Root = JobRunner.RepoRoot(Directory.GetCurrentDirectory())!;
    private static readonly string Calculator = Path.Combine(Root, "tests", "fixtures", "wsdl", "calculator-two-ports.wsdl");

    private static JsonObject Data(string wsdl, string extra = "") => JsonNode.Parse(
        $"{{\"wsdl\":{{\"path\":{System.Text.Json.JsonSerializer.Serialize(wsdl)},\"sha256\":\"{IntegrationDocuments.Sha256(File.ReadAllBytes(wsdl))}\"}}{(extra.Length > 0 ? "," + extra : "")}}}")!.AsObject();

    private static string Temp(string content)
    {
        var dir = Path.Combine(Root, ".local", "soap-plan-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var file = Path.Combine(dir, "service.wsdl");
        File.WriteAllText(file, content);
        return file;
    }

    private static string Codes(SoapPlan.Result r) => string.Join(",", r.Problems.Select(p => p.Code));

    [Fact]
    public void TheSingleSoap11PortWinsByDefault()
    {
        var plan = SoapPlan.Plan(Data(Calculator, "\"methods\":[\"Add\"]"));
        Assert.Empty(plan.Problems);
        Assert.Equal("CalculatorSoap", plan.Selection!.Port.Name);
        Assert.Equal("1.1", plan.Selection.Port.SoapVersion);
        Assert.Equal("CalculatorSoapBinding", plan.Selection.Port.Binding);
        Assert.Equal("Calculator", plan.Selection.Client);
        Assert.Equal(2, plan.Ports.Count);
    }

    [Fact]
    public void TheBindingResolvesToTheNativePortAndSoapVersionSelects()
    {
        var byBinding = SoapPlan.Plan(Data(Calculator, "\"binding\":\"tns:CalculatorSoap12Binding\",\"methods\":[\"Add\",\"Subtract\"]"));
        Assert.Empty(byBinding.Problems);
        Assert.Equal("CalculatorSoap12", byBinding.Selection!.Port.Name);
        var byVersion = SoapPlan.Plan(Data(Calculator, "\"soapVersion\":\"soap12\",\"methods\":[\"Add\"]"));
        Assert.Equal("CalculatorSoap12", byVersion.Selection!.Port.Name);
        Assert.Equal("1.2", byVersion.Selection.Port.SoapVersion);
    }

    [Fact]
    public void EachSelectorHasItsNotFoundWithTheChoices()
    {
        foreach (var (selector, code) in new[] { ("\"service\":\"Nope\"", "SERVICE_NOT_FOUND"), ("\"port\":\"Nope\"", "PORT_NOT_FOUND"), ("\"binding\":\"Nope\"", "BINDING_NOT_FOUND") })
        {
            var plan = SoapPlan.Plan(Data(Calculator, selector + ",\"methods\":[\"Add\"]"));
            Assert.Null(plan.Selection);
            var problem = Assert.Single(plan.Problems);
            Assert.Equal(code, problem.Code);
            Assert.Contains("CalculatorSoap", problem.Message);
        }
        // A WSDL with only a SOAP 1.1 port has no 1.2 choice.
        var only11 = File.ReadAllText(Calculator).Replace("<wsdl:port name=\"CalculatorSoap12\" binding=\"tns:CalculatorSoap12Binding\"><soap12:address location=\"https://example.invalid/calculator.asmx\" /></wsdl:port>", "");
        var version = SoapPlan.Plan(Data(Temp(only11), "\"soapVersion\":\"1.2\",\"methods\":[\"Add\"]"));
        Assert.Equal("SOAP_VERSION_NOT_FOUND", Codes(version));
    }

    [Fact]
    public void AMissingMethodIsRefusedNamingItAndTheAvailableOnes()
    {
        var plan = SoapPlan.Plan(Data(Calculator, "\"methods\":[\"Add\",\"NotARealMethod\"]"));
        Assert.Null(plan.Selection);
        var problem = Assert.Single(plan.Problems);
        Assert.Equal("SOAP_METHOD_NOT_FOUND", problem.Code);
        Assert.Contains("NotARealMethod", problem.Message);
        Assert.Contains("Add", problem.Fix);
    }

    [Fact]
    public void ADtdOrEntityIsUnsafe()
    {
        var withDtd = File.ReadAllText(Calculator).Replace("<?xml version=\"1.0\" encoding=\"utf-8\"?>", "<?xml version=\"1.0\"?><!DOCTYPE x [<!ENTITY e \"boom\">]>");
        Assert.Equal("UNSAFE_WSDL_XML", Codes(SoapPlan.Plan(Data(Temp(withDtd), "\"methods\":[\"Add\"]"))));
        Assert.Equal("INVALID_WSDL_XML", Codes(SoapPlan.Plan(Data(Temp("<wsdl:definitions"), "\"methods\":[\"Add\"]"))));
        Assert.Equal("INVALID_WSDL_ROOT", Codes(SoapPlan.Plan(Data(Temp("<html><body>service page</body></html>"), "\"methods\":[\"Add\"]"))));
        Assert.Equal("WSDL_HAS_NO_SOAP_PORTS", Codes(SoapPlan.Plan(Data(Temp("<definitions xmlns=\"http://schemas.xmlsoap.org/wsdl/\"/>"), "\"methods\":[\"Add\"]"))));
    }

    [Fact]
    public void AmbiguityListsEveryChoice()
    {
        // Two services, each with its own SOAP 1.1 port exposing Add: nothing decides between them.
        var text = File.ReadAllText(Calculator).Replace("</wsdl:definitions>",
            "<wsdl:service name=\"CalculatorMirror\"><wsdl:port name=\"MirrorSoap\" binding=\"tns:CalculatorSoapBinding\"><soap:address location=\"https://example.invalid/mirror.asmx\" /></wsdl:port></wsdl:service></wsdl:definitions>");
        var plan = SoapPlan.Plan(Data(Temp(text), "\"methods\":[\"Add\"]"));
        var problem = Assert.Single(plan.Problems);
        Assert.Equal("AMBIGUOUS_SOAP_PORT", problem.Code);
        Assert.Contains("port=CalculatorSoap,", problem.Message);
        Assert.Contains("port=MirrorSoap,", problem.Message);
        Assert.Contains("\"port\": \"MirrorSoap\"", problem.Fix);
        // Naming the port settles it.
        Assert.Equal("MirrorSoap", SoapPlan.Plan(Data(Temp(text), "\"port\":\"MirrorSoap\",\"methods\":[\"Add\"]")).Selection!.Port.Name);
    }

    [Fact]
    public void ThePinnedBytesAreTheOnesPlanned()
    {
        var data = Data(Calculator, "\"methods\":[\"Add\"]");
        data["wsdl"]!["sha256"] = new string('0', 64);
        Assert.Equal("DOCUMENT_SHA256_MISMATCH", Codes(SoapPlan.Plan(data)));
        // A URL is never fetched by the kernel: the deliver pins it first.
        Assert.Equal("DOCUMENT_NOT_PINNED", Codes(SoapPlan.Plan(JsonNode.Parse("{\"wsdl\":\"https://example.invalid/Calc.asmx?WSDL\",\"methods\":[\"Add\"]}")!.AsObject())));
        Assert.Equal("SOAP_METHODS_REQUIRED,WSDL_REQUIRED", Codes(SoapPlan.Plan(JsonNode.Parse("{}")!.AsObject())));
        Assert.Contains("SOAP_UNKNOWN_KEYS", Codes(SoapPlan.Plan(JsonNode.Parse("{\"wsdl\":\"x\",\"methods\":[\"Add\"],\"metods\":[]}")!.AsObject())));
    }

    [Fact]
    public void TheClientNameIsSanitized()
    {
        Assert.Equal("Country_Info_Service", SoapPlan.ClientName("Country Info-Service"));
        Assert.Equal("Soap_1stService", SoapPlan.ClientName("1stService"));
        Assert.Equal(50, SoapPlan.ClientName(new string('A', 80)).Length);
        var plan = SoapPlan.Plan(Data(Calculator, "\"client\":\"Calc-1\",\"methods\":[\"Add\"]"));
        Assert.Equal("SOAP_CLIENT_NAME_INVALID", Codes(plan));
        Assert.Contains("Calc_1", plan.Problems[0].Fix);
    }
}
