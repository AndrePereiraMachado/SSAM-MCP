using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// The contract check of an imported SOAP client (SoapContract): a parameter keeps the exact WSDL type. A complex type
/// typed Text, or typed by a structure of another key, is SOAP_CONTRACT_TYPE_MISMATCH; the client's own structure of that
/// name, bound by key, passes; a primitive maps to its OutSystems type. Pure records first, then the same check read from
/// a headless model built with the raw creators (ISOAPClient, ISOAPStructure, ISOAPAction, ISOAPActionOutput).
/// </summary>
public class SoapContractTests
{
    private static readonly string Root = JobRunner.RepoRoot(Directory.GetCurrentDirectory())!;
    private static readonly SoapContract.Structure Operands = new("tOperands", "tOperands", "key-operands");

    [Fact]
    public void ComplexTypedTextOrAnotherKeyIsAMismatchAndTheExactStructurePasses()
    {
        var text = new SoapContract.Parameter("Subtract", "input", "Operands", "tns:tOperands", "Text", null);
        var other = new SoapContract.Parameter("Subtract", "input", "Operands", "tns:tOperands", "tOperands", "key-elsewhere");
        var exact = new SoapContract.Parameter("Subtract", "input", "Operands", "tns:tOperands", "tOperands", "key-operands");
        var list = new SoapContract.Parameter("Subtract", "input", "Many", "tns:tOperands", "tOperands List", "key-operands");
        Assert.Equal("SOAP_CONTRACT_TYPE_MISMATCH", Assert.Single(SoapContract.Check([text], [Operands])).Code);
        var problem = Assert.Single(SoapContract.Check([other], [Operands]));
        Assert.Contains("key-elsewhere", problem.Message);
        Assert.Contains("refresh", problem.Fix);
        Assert.Empty(SoapContract.Check([exact, list], [Operands]));
        Assert.Single(SoapContract.Check([new SoapContract.Parameter("Get", "output", "Result", "tns:tMissing", "Text", null)], [Operands]));
    }

    [Fact]
    public void PrimitivesMapToTheirOutSystemsTypes()
    {
        Assert.Empty(SoapContract.Check([new("Add", "input", "intA", "s:int", "Integer", null), new("Add", "output", "AddResult", "{http://www.w3.org/2001/XMLSchema}long", "Long Integer", null),
            new("Add", "input", "When", "xsd:dateTime", "Date Time", null), new("Add", "input", "Blob", "s:base64Binary", "Binary Data", null)], []));
        Assert.Equal("SOAP_CONTRACT_TYPE_MISMATCH", Assert.Single(SoapContract.Check([new("Add", "input", "intA", "s:int", "Text", null)], [])).Code);
        Assert.Equal("Decimal", SoapContract.PrimitiveOf("s:double"));
        Assert.Null(SoapContract.PrimitiveOf("tns:tOperands"));
    }

    [Theory]
    [InlineData("http://www.w3.org/2001/XMLSchema:decimal", "Text")]
    [InlineData("{http://www.w3.org/2001/XMLSchema}decimal", "Text")]
    [InlineData("xsd:decimal", "Text")]
    [InlineData("xsd:decimal", "Decimal")]
    public void NativeDecimalRepresentationsKeepTheSoapContract(string original, string actual)
    {
        Assert.Empty(SoapContract.Check([new("NumberToDollars", "input", "dNum", original, actual, null)], []));
    }

    [Theory]
    [InlineData("xsd:decimal", "Integer")]
    [InlineData("xsd:decimal", "Boolean")]
    [InlineData("xsd:int", "Text")]
    [InlineData("xsd:double", "Text")]
    [InlineData("tns:tOperands", "Text")]
    public void DecimalCompatibilityDoesNotHideOtherTypeLoss(string original, string actual)
    {
        Assert.Equal("SOAP_CONTRACT_TYPE_MISMATCH", Assert.Single(SoapContract.Check(
            [new("Convert", "input", "Value", original, actual, null)], [Operands])).Code);
    }

    /// <summary>The imported client as the Studio's importer leaves it, built with the raw creators (with the occurrences and the
    /// original names the importer always writes: without them Verify refuses the client, and since the single refusal of
    /// 9cb0f8e8 that verdict joins the contract problem in one PREFLIGHT_REFUSED); the operand input typed by
    /// <paramref name="operandType"/>.</summary>
    private static string Imported(string operandType) => $$$"""
        [{"op":"create","parent":"@espace","type":"ISOAPClient","name":"Calculator","as":"$c","allowSoapWithoutImport":{"why":"the imported client as the importer leaves it, built by verbs for the test"}},
         {"op":"create","parent":"$c","type":"ISOAPStructure","name":"tOperands","as":"$s"},
         {"op":"set","target":"$s","prop":"OriginalName","value":"tOperands"},
         {"op":"create","parent":"$s","type":"ISOAPStructureAttribute","name":"A","as":"$sa"},
         {"op":"set","target":"$sa","prop":"DataType","value":"Integer"},
         {"op":"set","target":"$sa","prop":"MinOccurrencies","value":"1"},
         {"op":"create","parent":"$c","type":"ISOAPAction","name":"Subtract","as":"$m"},
         {"op":"create","parent":"$m","type":"ISOAPActionInput","name":"Operands","as":"$in"},
         {"op":"set","target":"$in","prop":"OriginalType","value":"tns:tOperands"},
         {"op":"set","target":"$in","prop":"DataType","value":"{{{operandType}}}"},
         {"op":"set","target":"$in","prop":"OriginalName","value":"Operands"},
         {"op":"set","target":"$in","prop":"MinOccurrencies","value":"1"},
         {"op":"set","target":"$in","prop":"MaxOccurrencies","value":"1"},
         {"op":"create","parent":"$m","type":"ISOAPActionOutput","name":"SubtractResult","as":"$out"},
         {"op":"set","target":"$out","prop":"OriginalType","value":"s:int"},
         {"op":"set","target":"$out","prop":"DataType","value":"Integer"},
         {"op":"set","target":"$out","prop":"OriginalName","value":"SubtractResult"},
         {"op":"set","target":"$out","prop":"MinOccurrencies","value":"1"},
         {"op":"set","target":"$out","prop":"MaxOccurrencies","value":"1"},
         {"op":"soap","data":{"wsdl":{"path":{{{System.Text.Json.JsonSerializer.Serialize(Path.Combine(Root, "tests", "fixtures", "wsdl", "calculator-two-ports.wsdl"))}}}},"port":"CalculatorSoap","methods":["Subtract"]}}]
        """;

    [Fact]
    public void TheSoapOpChecksTheImportedClientOnTheModel()
    {
        if (!StudioAvailable()) return;
        var (_, error, output) = DeleteBreaksTests.Run(null, JsonNode.Parse(Imported("Text"))!.AsArray(), expectValid: true);
        var coded = Errors.FindCoded(error!)!;
        Assert.Equal("SOAP_CONTRACT_TYPE_MISMATCH", coded.Code);
        var problem = Assert.Single(coded.Problems!);
        Assert.Contains("Subtract.Operands", problem!["message"]!.ToString());
        Assert.Contains("tOperands", problem["message"]!.ToString());
        Assert.False(File.Exists(output));
        // The client's own structure, bound by key: the soap op passes and reports the method it found.
        var (result, passed, _) = DeleteBreaksTests.Run(null, JsonNode.Parse(Imported("tOperands"))!.AsArray(), expectValid: true);
        Assert.Null(passed);
        var report = Assert.Single(result!["integration"]!.AsArray())!;
        Assert.Equal(["Subtract"], report["skipped"]!.AsArray().Select(s => s!.ToString()));
        Assert.Equal("CalculatorSoap", report["selection"]!["port"]!.ToString());
        // Without the method on the client the job needs the Studio's importer (o11_deliver).
        var (_, missing, _) = DeleteBreaksTests.Run(null, JsonNode.Parse(Imported("tOperands").Replace("\"methods\":[\"Subtract\"]", "\"methods\":[\"Add\"]"))!.AsArray(), expectValid: true);
        Assert.Equal(IntegrationImport.NeedsStudio, Errors.FindCoded(missing!)!.Code);
    }

    private static bool StudioAvailable()
    {
        try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; }
    }
}
