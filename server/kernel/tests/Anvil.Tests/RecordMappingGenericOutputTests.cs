using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// F7 (25/10/2026), the two mappings of the owner's SSAMCoverageSoapWire delivery that the apply refused as
/// "not two different record (or list) types" (FLOW_MAPPING_TYPES):
/// <list type="bullet">
/// <item>`Filtradas = (System).ListFilter(SourceList=Fetch.Response, ...)` then `Postagens = Filtradas.FilteredList mapTo {...}`:
/// the generic output of ListFilter takes its type from SourceList, read when the call had no scope yet. The type is now
/// inferred (the call's arguments read again, Ss11RecordMappings.Write): the mapping is written and the Verify finds it
/// (no Empty Mapping). Not left to the Verify.</item>
/// <item>`Paises = Fetch.ListOfCountryNamesByNameResult mapTo {...}`: the SOAP result is a record (ArrayOftCountryCodeAndName)
/// whose attribute tCountryCodeAndName is the list: the author's mistake, still refused, now naming the attribute to map from.</item>
/// </list>
/// </summary>
public class RecordMappingGenericOutputTests
{
    private static readonly string Root = JobRunner.RepoRoot(Directory.GetCurrentDirectory())!;

    private static JsonNode Rest() => JsonNode.Parse("""
        {"op":"rest","data":{"client":{"name":"JSONPlaceholderApi","baseUrl":"https://jsonplaceholder.typicode.com"},
          "structures":[{"name":"PostagemRest","attributes":[{"name":"id","type":"Integer"},{"name":"userId","type":"Integer"},{"name":"title","type":"Text"},{"name":"body","type":"Text"}]}],
          "methods":[{"name":"ListarPostagensRest","http":"GET","path":"/posts","response":{"type":"PostagemRest List","format":"JSON"}}]}}
        """)!;

    private static JsonNode Spec(string ddl) => new JsonObject { ["op"] = "spec", ["data"] = new JsonObject { ["ddl"] = ddl } };
    private static JsonNode Logic(string text) => new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(text) } };

    [Fact]
    public void TheListFilterOutputTakesTheTypeOfItsSourceListAndTheMappingIsWritten()
    {
        if (!StudioAvailable()) return;
        var ops = new JsonArray(
            Spec("type PostagemDemo public = {\n Id: Integer;\n UserId: Integer;\n Titulo: Text(250);\n Corpo: Text(4000);\n}\n"),
            Rest(),
            Logic("server action ListarPostagensDemo public\n  in ExternalUserId?: Integer = 0\n  out Postagens: PostagemDemo List\n  Fetch = ListarPostagensRest()\n"
                + "  Filtradas = (System).ListFilter(List=Fetch.Response, Condition=ExternalUserId = 0 or userId = ExternalUserId)\n"
                + "  assign Postagens = Filtradas.FilteredList mapTo { Id: id, UserId: userId, Titulo: title, Corpo: body }\n  end\n"));
        var (result, error, _) = DeleteBreaksTests.Run(null, ops, expectValid: true);
        Assert.Null(error);
        Assert.True(result!["accepted"]!.GetValue<bool>());
        Assert.DoesNotContain(result["details"]!.AsArray().Select(d => d!.ToString()), d => d.StartsWith("Error", StringComparison.Ordinal));
    }

    [Fact]
    public void ARecordThatHoldsTheListNamesTheAttributeToMapFrom()
    {
        if (!StudioAvailable()) return;
        var wsdl = Path.Combine(Root, "tests", "fixtures", "wsdl", "CountryInfoService.wso");
        var ops = new JsonArray(
            Spec("type DadosPais public = {\n Codigo: Text(2);\n Nome: Text(200);\n}\n"),
            new JsonObject { ["op"] = "soap", ["data"] = new JsonObject {
                ["wsdl"] = new JsonObject { ["path"] = wsdl, ["sha256"] = IntegrationDocuments.Sha256(File.ReadAllBytes(wsdl)) },
                ["client"] = "CountryInfo", ["soapVersion"] = "1.1", ["methods"] = new JsonArray("ListOfCountryNamesByName") } },
            Logic("server action ListarPaises public\n  out Paises: DadosPais List\n  Fetch = ListOfCountryNamesByName()\n"
                + "  assign Paises = Fetch.ListOfCountryNamesByNameResult mapTo { Codigo: sISOCode, Nome: sName }\n  end\n"));
        var (_, error, _) = DeleteBreaksTests.Run(Path.Combine(Root, "tests", "fixtures", "soap-wire", "import-1.oml"), ops.DeepClone().AsArray(), expectValid: true);
        var problems = Errors.FindCoded(error!)!.Problems!.OfType<JsonObject>().Where(p => p["code"]!.ToString() == "FLOW_MAPPING_TYPES").ToList();
        var problem = Assert.Single(problems);
        Assert.Contains("(Fetch.ListOfCountryNamesByNameResult is ArrayOftCountryCodeAndName, Paises is DadosPais List)", problem["message"]!.ToString());
        Assert.Contains("its attribute tCountryCodeAndName is the tCountryCodeAndName List: write Fetch.ListOfCountryNamesByNameResult.tCountryCodeAndName mapTo", problem["message"]!.ToString());
        // Mapped from the attribute that is the list, the same op is written.
        ops[2] = Logic(ops[2]!["data"]!["flow"]![0]!.ToString().Replace("ListOfCountryNamesByNameResult mapTo", "ListOfCountryNamesByNameResult.tCountryCodeAndName mapTo"));
        var (fixedResult, none, _) = DeleteBreaksTests.Run(Path.Combine(Root, "tests", "fixtures", "soap-wire", "import-1.oml"), ops, expectValid: true);
        Assert.Null(none);
        Assert.True(fixedResult!["accepted"]!.GetValue<bool>());
    }

    private static bool StudioAvailable()
    {
        try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; }
    }
}
