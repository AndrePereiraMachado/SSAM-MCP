using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public class SoapMetadataMergeTests
{
    [Theory]
    [InlineData("same", true)]
    [InlineData("payload", false)]
    [InlineData("name", false)]
    [InlineData("owner", false)]
    [InlineData("missing", false)]
    public void RegeneratedMetadataKeysAreNotContentButSlotAndPayloadAre(string change, bool accepted)
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(SoapMetadataMergeTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "soap-metadata-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(Path.Combine(work, "model"));
        var basis = File.ReadAllBytes(Path.Combine(root, "tests", "fixtures", "blank-service.oml"));
        // Both candidates start from the same owner keys. Only the metadata record is regenerated independently.
        var owners = Path.Combine(work, "owners.oml");
        CompileCheck.WriteUnchecked(host, basis, JsonNode.Parse("""
            [{"op":"create","parent":"@espace","type":"ISOAPClient","name":"NumberConversion",
              "allowSoapWithoutImport":{"why":"Construct the metadata owner for a local content-proof regression"}},
             {"op":"create","parent":"@espace","type":"ISOAPClient","name":"OtherConversion",
              "allowSoapWithoutImport":{"why":"Construct a second owner to check that metadata cannot move silently"}}]
            """)!.AsArray(), owners);
        string Candidate(string file, string owner, string name, string payload, bool metadata = true)
        {
            var path = Path.Combine(work, file);
            var ops = metadata ? new JsonArray(
                new JsonObject { ["op"] = "create", ["parent"] = "ISOAPClient:" + owner, ["type"] = "IBinaryMetadata", ["name"] = name, ["as"] = "$metadata",
                    ["args"] = new JsonObject { ["managedBy"] = "SOAP" } },
                new JsonObject { ["op"] = "set", ["target"] = "$metadata", ["prop"] = "Value", ["value"] = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(payload)) }) : new JsonArray();
            CompileCheck.WriteUnchecked(host, File.ReadAllBytes(owners), ops, path);
            return path;
        }
        var expected = Candidate("expected.oml", "NumberConversion", "WsdlServiceMetadata;NumberConversion_wsdl", "wsdl-content");
        var actual = Candidate("actual.oml", change == "owner" ? "OtherConversion" : "NumberConversion",
            change == "name" ? "DifferentMetadata" : "WsdlServiceMetadata;NumberConversion_wsdl",
            change == "payload" ? "different-wsdl-content" : "wsdl-content", change != "missing");
        var proof = MergeContentProof.Check(host, expected, actual);
        Assert.Equal(accepted, proof["accepted"]!.GetValue<bool>());
    }
}
